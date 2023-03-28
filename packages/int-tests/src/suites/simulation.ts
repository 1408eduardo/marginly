import { BigNumber } from 'ethers';
import { formatUnits, parseUnits } from 'ethers/lib/utils';
import { SystemUnderTest } from '.';
import bn from 'bignumber.js';
import { FP96, toHumanString } from '../utils/fixed-point';
import { logger } from '../utils/logger';
import { changeWethPrice } from '../utils/uniswap-ops';
import { showSystemAggregates } from '../utils/log-utils';

export async function prepareAccounts(sut: SystemUnderTest) {
  const { treasury, usdc, weth, accounts } = sut;
  logger.debug(`Depositing accounts`);
  for (let i = 0; i < 4; i++) {
    const account = accounts[i];
    await Promise.all([
      (await usdc.connect(treasury).transfer(account.address, parseUnits('5000', 6), { gasLimit: 80_000 })).wait(),
      (await weth.connect(treasury).transfer(account.address, parseUnits('10', 18), { gasLimit: 80_000 })).wait(),
    ]);
  }
  logger.debug(`Depositing accounts completed`);
}

/*
 Lender deposit WETH
 Shorter open short position with big leverage
 Longer open long position on all short collateral
 After some time pool hasn't enough liquidity to enact margin call for short position
 Liquidator receive short position with deposit of 1000 USDC
*/
export async function simulation1(sut: SystemUnderTest) {
  logger.info(`Starting simulation1 test suite`);
  const { marginlyPool, usdc, weth, accounts, treasury, provider } = sut;

  await prepareAccounts(sut);

  const lender = accounts[0];
  const shorter = accounts[1];
  const longer = accounts[2];
  const receiver = accounts[3];

  // lender deposit 2.0 ETH
  const lenderDeposiBaseAmount = parseUnits('2', 18);
  logger.info(`Lender deposit ${formatUnits(lenderDeposiBaseAmount, 18)} WETH`);
  await (await weth.connect(lender).approve(marginlyPool.address, lenderDeposiBaseAmount)).wait();
  await (await marginlyPool.connect(lender).depositBase(lenderDeposiBaseAmount, { gasLimit: 400_000 })).wait();
  await showSystemAggregates(sut);

  //shorter deposit 1000 USDC
  const shorterDepositQuote = parseUnits('250', 6);
  logger.info(`Shorter deposit ${formatUnits(shorterDepositQuote, 6)} USDC`);
  await (await usdc.connect(shorter).approve(marginlyPool.address, shorterDepositQuote)).wait();
  await (await marginlyPool.connect(shorter).depositQuote(shorterDepositQuote, { gasLimit: 400_000 })).wait();

  //shorter make short on 2.0 ETH
  const shortAmount = parseUnits('2', 18);
  await (await marginlyPool.connect(shorter).short(shortAmount, { gasLimit: 900_000 })).wait();
  logger.info(`Short to ${formatUnits(shortAmount, 18)} WETH`);
  await showSystemAggregates(sut);

  // longer deposit 0.1 ETH
  const longDepositBase = parseUnits('0.1', 18);
  logger.info(`Longer deposit ${formatUnits(longDepositBase, 18)} WETH`);
  await (await weth.connect(longer).approve(marginlyPool.address, longDepositBase)).wait();
  await (await marginlyPool.connect(longer).depositBase(longDepositBase, { gasLimit: 400_000 })).wait();

  // longer make long on 1.8 ETH
  const longAmount = parseUnits('0.5', 18);
  logger.info(`Long to ${formatUnits(longAmount, 18)} WETH`);
  await (await marginlyPool.connect(longer).long(longAmount, { gasLimit: 900_000 })).wait();
  await showSystemAggregates(sut);

  //shift dates and reinit
  logger.info(`Shift date for 1 month, 1 day per iteration`);
  // shift time to 1 year
  const numOfSeconds = 24 * 60 * 60; // 1 day
  let nextDate = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 30; i++) {
    logger.info(`Iteration ${i + 1} of 30`);
    nextDate += numOfSeconds;
    await provider.mineAtTimestamp(nextDate);

    try {
      const txReceipt = await (await marginlyPool.connect(treasury).reinit({ gasLimit: 500_000 })).wait();
      const marginCallEvent = txReceipt.events?.find((e) => e.event == 'EnactMarginCall');
      if (marginCallEvent) {
        logger.info(`\n`);
        logger.warn(`Margin call happened at day ${i} (${nextDate} time)`);
        logger.warn(` mc account: ${marginCallEvent.args![0]}`);
      }
    } catch {
      // we are in  liquidity shortage state try to receive position and continue
      logger.warn(`⛔️ Pool liquidity not enough to cover position debt`);
      logger.info(`   bad position ${shorter.address}`);

      const quoteAmount = parseUnits('1000', 6); // 1000 USDC
      const wethAmount = parseUnits('0', 18); // 0 ETH

      await (await usdc.connect(receiver).approve(marginlyPool.address, quoteAmount)).wait();
      await (await weth.connect(receiver).approve(marginlyPool.address, wethAmount)).wait();

      await (
        await marginlyPool
          .connect(receiver)
          .receivePosition(shorter.address, quoteAmount, wethAmount, { gasLimit: 300_000 })
      ).wait();

      logger.info(`☠️ bad position liquidated`);
    }

    await showSystemAggregates(sut);
  }
}

/// Lender USDC
export async function simulation2(sut: SystemUnderTest) {
  logger.info(`Starting simulation2 test suite`);
  const { marginlyPool, usdc, weth, accounts, treasury, provider } = sut;

  await prepareAccounts(sut);

  const lender = accounts[0];
  const shorter = accounts[1];
  const longer = accounts[2];
  const liquidator = accounts[3];

  // lender deposit 3200 USDC
  const lenderDeposiQuoteAmount = parseUnits('3200', 6);
  logger.info(`Lender deposit ${formatUnits(lenderDeposiQuoteAmount, 6)} UDSC`);
  await (await usdc.connect(lender).approve(marginlyPool.address, lenderDeposiQuoteAmount)).wait();
  await (await marginlyPool.connect(lender).depositQuote(lenderDeposiQuoteAmount, { gasLimit: 400_000 })).wait();
  await showSystemAggregates(sut);

  // longer deposit 0.3 ETH
  const longDepositBase = parseUnits('0.2', 18);
  logger.info(`Longer deposit ${formatUnits(longDepositBase, 18)} WETH`);
  await (await weth.connect(longer).approve(marginlyPool.address, longDepositBase)).wait();
  await (await marginlyPool.connect(longer).depositBase(longDepositBase, { gasLimit: 400_000 })).wait();

  // longer make long on 2.0 ETH
  const longAmount = parseUnits('1.8', 18);
  logger.info(`Long to ${formatUnits(longAmount, 18)} WETH`);
  await (await marginlyPool.connect(longer).long(longAmount, { gasLimit: 900_000 })).wait();
  await showSystemAggregates(sut);

  //shorter deposit 300 USDC
  const shorterDepositQuote = parseUnits('600', 6);
  logger.info(`Shorter deposit ${formatUnits(shorterDepositQuote, 6)} USDC`);
  await (await usdc.connect(shorter).approve(marginlyPool.address, shorterDepositQuote)).wait();
  await (await marginlyPool.connect(shorter).depositQuote(shorterDepositQuote, { gasLimit: 400_000 })).wait();

  //shorter make short on 2.0 ETH
  const shortAmount = parseUnits('2', 18);
  await (await marginlyPool.connect(shorter).short(shortAmount, { gasLimit: 900_000 })).wait();
  logger.info(`Short to ${formatUnits(shortAmount, 18)} WETH`);
  await showSystemAggregates(sut);

  //shift dates and reinit
  logger.info(`Shift date for 1 month, 1 day per iteration`);
  // shift time to 1 year
  const numOfSeconds = 24 * 60 * 60; // 1 day
  let nextDate = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 30; i++) {
    logger.info(`Iteration ${i + 1} of 30`);
    nextDate += numOfSeconds;
    await provider.mineAtTimestamp(nextDate);

    try {
      const txReceipt = await (await marginlyPool.connect(treasury).reinit({ gasLimit: 500_000 })).wait();
      const marginCallEvent = txReceipt.events?.find((e) => e.event == 'EnactMarginCall');
      if (marginCallEvent) {
        logger.info(`\n`);
        logger.warn(`Margin call happened at day ${i} (${nextDate} time)`);
        logger.warn(` mc account: ${marginCallEvent.args![0]}`);
      }
    } catch {
      // we are in  liquidity shortage state try to receive position and continue
      logger.warn(`⛔️ Pool liquidity not enough to cover position debt`);
      logger.info(`   bad position ${longer.address}`);

      const quoteAmount = parseUnits('0', 6); // 0 USDC
      const wethAmount = parseUnits('1', 18); // 0 ETH

      await (await usdc.connect(liquidator).approve(marginlyPool.address, quoteAmount)).wait();
      await (await weth.connect(liquidator).approve(marginlyPool.address, wethAmount)).wait();

      await (
        await marginlyPool
          .connect(liquidator)
          .receivePosition(longer.address, quoteAmount, wethAmount, { gasLimit: 300_000 })
      ).wait();

      logger.info(`☠️ bad position liquidated`);
    }
    await showSystemAggregates(sut);
  }
}

export async function simulation3(sut: SystemUnderTest) {
  logger.info(`Starting simulation2 test suite`);
  const { marginlyPool, usdc, weth, accounts, treasury, provider } = sut;

  await prepareAccounts(sut);

  const lender = accounts[0];
  const shorter = accounts[1];
  const longer = accounts[2];

  // lender deposit 3200 USDC and 2.0 ETH
  const lenderDeposiQuoteAmount = parseUnits('3200', 6);
  logger.info(`Lender deposit ${formatUnits(lenderDeposiQuoteAmount, 6)} UDSC`);
  await (await usdc.connect(lender).approve(marginlyPool.address, lenderDeposiQuoteAmount)).wait();
  await (await marginlyPool.connect(lender).depositQuote(lenderDeposiQuoteAmount, { gasLimit: 400_000 })).wait();

  const lenderDeposiBaseAmount = parseUnits('0.1', 18);
  await (await weth.connect(lender).approve(marginlyPool.address, lenderDeposiBaseAmount)).wait();
  await (await marginlyPool.connect(lender).depositBase(lenderDeposiBaseAmount, { gasLimit: 400_000 })).wait();
  await showSystemAggregates(sut);

  // longer deposit 0.3 ETH
  const longDepositBase = parseUnits('0.3', 18);
  logger.info(`Longer deposit ${formatUnits(longDepositBase, 18)} WETH`);
  await (await weth.connect(longer).approve(marginlyPool.address, longDepositBase)).wait();
  await (await marginlyPool.connect(longer).depositBase(longDepositBase, { gasLimit: 400_000 })).wait();

  // longer make long on 2.0 ETH
  const longAmount = parseUnits('1.8', 18);
  logger.info(`Long to ${formatUnits(longAmount, 18)} WETH`);
  await (await marginlyPool.connect(longer).long(longAmount, { gasLimit: 900_000 })).wait();
  await showSystemAggregates(sut);

  //shorter deposit 300 USDC
  const shorterDepositQuote = parseUnits('230', 6);
  logger.info(`Shorter deposit ${formatUnits(shorterDepositQuote, 6)} USDC`);
  await (await usdc.connect(shorter).approve(marginlyPool.address, shorterDepositQuote)).wait();
  await (await marginlyPool.connect(shorter).depositQuote(shorterDepositQuote, { gasLimit: 400_000 })).wait();

  //shorter make short on 2.0 ETH
  const shortAmount = parseUnits('2', 18);
  await (await marginlyPool.connect(shorter).short(shortAmount, { gasLimit: 900_000 })).wait();
  logger.info(`Short to ${formatUnits(shortAmount, 18)} WETH`);
  await showSystemAggregates(sut);

  //shift dates and reinit
  logger.info(`Shift date for 1 month, 1 day per iteration`);
  // shift time to 1 year
  const numOfSeconds = 24 * 60 * 60; // 1 day
  let nextDate = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 30; i++) {
    logger.info(`Iteration ${i + 1} of 30`);
    nextDate += numOfSeconds;
    await provider.mineAtTimestamp(nextDate);

    const txReceipt = await (await marginlyPool.connect(treasury).reinit({ gasLimit: 500_000 })).wait();
    const marginCallEvent = txReceipt.events?.find((e) => e.event == 'EnactMarginCall');
    if (marginCallEvent) {
      logger.info(`\n`);
      logger.warn(`Margin call happened at day ${i} (${nextDate} time)`);
      logger.warn(` mc account: ${marginCallEvent.args![0]}`);
    }

    await showSystemAggregates(sut);
  }
}
