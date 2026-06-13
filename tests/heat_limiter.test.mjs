import assert from 'node:assert/strict';

const NUM_LEDS = 104;
const MAX_MILLIAMPS = 1600;
const SUSTAINED_TARGET_MILLIAMPS = 500;
const SATURATION_DIM_START = 40;
const SATURATED_COLOR_SCALE = 255;
const HEAT_BUCKET_MAX = 10000;
const HEAT_STRESS_RANGE_MA = MAX_MILLIAMPS - SUSTAINED_TARGET_MILLIAMPS;
const RED_COMPENSATION_BUDGET_DIVISOR = 4;
const RED_COMPENSATION_MAX_PER_LED = 16;
const STANDBY_RED = 8;
const STANDBY_GREEN = 0;
const STANDBY_BLUE = 0;

const LED_REGION_BOTTOM = 0;
const LED_REGION_SIDE = 1;
const LED_REGION_TOP = 2;
const LED_REGION_INACTIVE = 255;
const LED_REGION_COUNT = 3;

function estimateMilliAmps(channelTotal) {
  return Math.floor((channelTotal * 20) / 255);
}

function estimateColorMilliAmps(ledCount, r, g, b) {
  return estimateMilliAmps(ledCount * (r + g + b));
}

function estimateActiveColorMilliAmps(r, g, b) {
  return estimateColorMilliAmps(activeLedCount(), r, g, b);
}

function updateHeatBucket(heatBucket, estimatedMilliAmps, elapsedMs) {
  if (elapsedMs === 0) {
    return heatBucket;
  }

  estimatedMilliAmps = Math.min(estimatedMilliAmps, MAX_MILLIAMPS);

  if (estimatedMilliAmps > SUSTAINED_TARGET_MILLIAMPS) {
    const stress = estimatedMilliAmps - SUSTAINED_TARGET_MILLIAMPS;
    const heatAdd = Math.floor((Math.floor((stress * stress) / HEAT_STRESS_RANGE_MA) * elapsedMs) / HEAT_STRESS_RANGE_MA);

    return Math.min(HEAT_BUCKET_MAX, heatBucket + heatAdd);
  }

  const heatDrop = Math.floor(((SUSTAINED_TARGET_MILLIAMPS - estimatedMilliAmps + 1) * elapsedMs) / SUSTAINED_TARGET_MILLIAMPS);

  return Math.max(0, heatBucket - heatDrop);
}

function heatLimitedScale(heatBucket, estimatedMilliAmps) {
  if (estimatedMilliAmps <= SUSTAINED_TARGET_MILLIAMPS || heatBucket === 0) {
    return 255;
  }

  const targetScale = Math.floor((SUSTAINED_TARGET_MILLIAMPS * 255) / estimatedMilliAmps);
  const scaleDrop = Math.floor((heatBucket * (255 - targetScale)) / HEAT_BUCKET_MAX);

  return 255 - scaleDrop;
}

function scaledMilliAmps(estimatedMilliAmps, scale) {
  return Math.floor((estimatedMilliAmps * scale) / 255);
}

function effectiveBudgetMilliAmps(estimatedMilliAmps, heatScale, scale) {
  if (scale < heatScale) {
    return MAX_MILLIAMPS;
  }

  return Math.min(MAX_MILLIAMPS, scaledMilliAmps(estimatedMilliAmps, scale));
}

function currentLimitedScale(estimatedMilliAmps, heatScale) {
  if (estimatedMilliAmps <= MAX_MILLIAMPS) {
    return heatScale;
  }

  const maxScale = Math.floor((MAX_MILLIAMPS * 255) / estimatedMilliAmps);

  return Math.min(heatScale, maxScale, 255);
}

function milliAmpsToChannelBudget(milliAmps) {
  return Math.floor((milliAmps * 255) / 20);
}

function scale8(value, scale) {
  return Math.floor((value * scale) / 256);
}

function limitSaturatedColor(r, g, b) {
  if (SATURATED_COLOR_SCALE === 255) {
    return { r, g, b };
  }

  const maxChannel = Math.max(r, g, b);
  const minChannel = Math.min(r, g, b);
  const saturation = maxChannel - minChannel;

  if (saturation <= SATURATION_DIM_START) {
    return { r, g, b };
  }

  const scale = 255 - Math.floor(((saturation - SATURATION_DIM_START) * (255 - SATURATED_COLOR_SCALE)) / (255 - SATURATION_DIM_START));

  return {
    r: scale8(r, scale),
    g: scale8(g, scale),
    b: scale8(b, scale),
  };
}

function isBottomLed(index) {
  return index <= 14 || index >= 89;
}

function isSideLed(index) {
  return (index >= 15 && index <= 31) || (index >= 72 && index <= 88);
}

function isTopLed(index) {
  return index >= 32 && index <= 71;
}

function isActiveLed(index) {
  if (isTopLed(index)) {
    return true;
  }

  if (index >= 15 && index <= 31) {
    return ((index - 15) % 2) === 0;
  }

  if (index >= 72 && index <= 88) {
    return ((index - 72) % 2) === 0;
  }

  if (index <= 14) {
    return ((index - 0) % 4) === 0;
  }

  if (index >= 89 && index <= 103) {
    return ((index - 89) % 4) === 0;
  }

  return false;
}

function ledRegion(index) {
  if (isTopLed(index)) {
    return LED_REGION_TOP;
  }

  if (isSideLed(index)) {
    return LED_REGION_SIDE;
  }

  if (isBottomLed(index)) {
    return LED_REGION_BOTTOM;
  }

  return LED_REGION_INACTIVE;
}

function activeLedCount() {
  let count = 0;

  for (let index = 0; index < NUM_LEDS; index += 1) {
    if (isActiveLed(index)) {
      count += 1;
    }
  }

  return count;
}

function regionActiveLedCount(region) {
  let count = 0;

  for (let index = 0; index < NUM_LEDS; index += 1) {
    if (ledRegion(index) === region && isActiveLed(index)) {
      count += 1;
    }
  }

  return count;
}

function createFrame(r, g, b) {
  return Array.from({ length: NUM_LEDS }, () => ({ r, g, b }));
}

function createRegionFrame(bottom, side, top) {
  return Array.from({ length: NUM_LEDS }, (_, index) => {
    if (ledRegion(index) === LED_REGION_TOP) {
      return { ...top };
    }

    if (ledRegion(index) === LED_REGION_SIDE) {
      return { ...side };
    }

    if (ledRegion(index) === LED_REGION_BOTTOM) {
      return { ...bottom };
    }

    return { r: 0, g: 0, b: 0 };
  });
}

function applyRegionMask(leds) {
  let channelTotal = 0;
  const masked = leds.map((led, index) => {
    if (!isActiveLed(index)) {
      return { r: 0, g: 0, b: 0 };
    }

    channelTotal += led.r + led.g + led.b;
    return { ...led };
  });

  return { leds: masked, channelTotal };
}

function sumChannels(leds) {
  return leds.reduce((total, led) => total + led.r + led.g + led.b, 0);
}

function regionChannelTotals(leds) {
  const totals = [0, 0, 0];

  for (let index = 0; index < leds.length; index += 1) {
    const region = ledRegion(index);

    if (region === LED_REGION_INACTIVE || !isActiveLed(index)) {
      continue;
    }

    totals[region] += leds[index].r + leds[index].g + leds[index].b;
  }

  return totals;
}

function regionScaleFor(requestedChannelTotal, retainedChannelTotal) {
  if (requestedChannelTotal === 0 || retainedChannelTotal === 0) {
    return 0;
  }

  if (retainedChannelTotal >= requestedChannelTotal) {
    return 255;
  }

  const scale = Math.floor((retainedChannelTotal * 255) / requestedChannelTotal);

  return Math.min(scale, 255);
}

function applyPowerLimit(leds, budgetMilliAmps, compensateRed = budgetMilliAmps < MAX_MILLIAMPS) {
  const requestedChannelTotals = [0, 0, 0];
  const retainedChannelTotals = [0, 0, 0];
  const regionScales = [0, 0, 0];
  const budgetChannelTotal = milliAmpsToChannelBudget(budgetMilliAmps);
  let remainingBudget = budgetChannelTotal;

  for (let index = 0; index < leds.length; index += 1) {
    const region = ledRegion(index);

    if (region === LED_REGION_INACTIVE) {
      continue;
    }

    requestedChannelTotals[region] += leds[index].r + leds[index].g + leds[index].b;
  }

  retainedChannelTotals[LED_REGION_TOP] = Math.min(requestedChannelTotals[LED_REGION_TOP], remainingBudget);
  remainingBudget -= retainedChannelTotals[LED_REGION_TOP];
  retainedChannelTotals[LED_REGION_SIDE] = Math.min(requestedChannelTotals[LED_REGION_SIDE], remainingBudget);
  remainingBudget -= retainedChannelTotals[LED_REGION_SIDE];
  retainedChannelTotals[LED_REGION_BOTTOM] = Math.min(requestedChannelTotals[LED_REGION_BOTTOM], remainingBudget);

  for (let region = 0; region < LED_REGION_COUNT; region += 1) {
    regionScales[region] = regionScaleFor(requestedChannelTotals[region], retainedChannelTotals[region]);
  }

  const displayed = leds.map((led, index) => {
    const region = ledRegion(index);

    if (region === LED_REGION_INACTIVE) {
      return { r: 0, g: 0, b: 0 };
    }

    const scale = regionScales[region];

    if (scale < 255) {
      return {
        r: scale8(led.r, scale),
        g: scale8(led.g, scale),
        b: scale8(led.b, scale),
      };
    }

    return { ...led };
  });

  let displayedChannelTotal = sumChannels(displayed);

  if (!compensateRed) {
    return { leds: displayed, channelTotal: displayedChannelTotal };
  }

  const remainingChannelBudget = Math.max(0, budgetChannelTotal - displayedChannelTotal);
  const boostBudget = Math.floor(remainingChannelBudget / RED_COMPENSATION_BUDGET_DIVISOR);

  if (boostBudget === 0) {
    return { leds: displayed, channelTotal: displayedChannelTotal };
  }

  let remainingBoost = boostBudget;
  let perLedBoost = Math.floor(boostBudget / activeLedCount());

  if (perLedBoost === 0) {
    perLedBoost = 1;
  } else if (perLedBoost > RED_COMPENSATION_MAX_PER_LED) {
    perLedBoost = RED_COMPENSATION_MAX_PER_LED;
  }

  for (const region of [LED_REGION_TOP, LED_REGION_SIDE, LED_REGION_BOTTOM]) {
    for (let index = 0; index < displayed.length && remainingBoost > 0; index += 1) {
      if (ledRegion(index) !== region || !isActiveLed(index)) {
        continue;
      }

      const led = displayed[index];
      const add = Math.min(255 - led.r, perLedBoost, remainingBoost);
      led.r += add;
      displayedChannelTotal += add;
      remainingBoost -= add;
    }
  }

  return { leds: displayed, channelTotal: displayedChannelTotal };
}

assert.equal(estimateMilliAmps(255), 20);
assert.equal(estimateMilliAmps(255 * 3 * 104), 6240);
assert.deepEqual(limitSaturatedColor(255, 0, 0), { r: 255, g: 0, b: 0 });
assert.deepEqual(limitSaturatedColor(0, 255, 255), { r: 0, g: 255, b: 255 });

assert.equal(activeLedCount(), 66);
assert.equal(regionActiveLedCount(LED_REGION_TOP), 40);
assert.equal(regionActiveLedCount(LED_REGION_SIDE), 18);
assert.equal(regionActiveLedCount(LED_REGION_BOTTOM), 8);
assert.equal(regionActiveLedCount(LED_REGION_TOP) + regionActiveLedCount(LED_REGION_SIDE) + regionActiveLedCount(LED_REGION_BOTTOM), activeLedCount());

assert(isActiveLed(0));
assert(isActiveLed(4));
assert(!isActiveLed(1));
assert(!isActiveLed(14));
assert(isActiveLed(15));
assert(!isActiveLed(16));
assert(isActiveLed(17));
assert(isActiveLed(31));
assert(isActiveLed(32));
assert(isActiveLed(71));
assert(isActiveLed(72));
assert(!isActiveLed(73));
assert(isActiveLed(88));
assert(isActiveLed(89));
assert(!isActiveLed(90));
assert(isActiveLed(93));
assert(!isActiveLed(103));

const maskedWhiteFrame = applyRegionMask(createFrame(255, 255, 255));
assert.equal(maskedWhiteFrame.channelTotal, 255 * 3 * activeLedCount());
assert.deepEqual(maskedWhiteFrame.leds[0], { r: 255, g: 255, b: 255 });
assert.deepEqual(maskedWhiteFrame.leds[1], { r: 0, g: 0, b: 0 });
assert.deepEqual(maskedWhiteFrame.leds[32], { r: 255, g: 255, b: 255 });
assert.deepEqual(maskedWhiteFrame.leds[73], { r: 0, g: 0, b: 0 });
assert.deepEqual(maskedWhiteFrame.leds[89], { r: 255, g: 255, b: 255 });
assert.deepEqual(maskedWhiteFrame.leds[103], { r: 0, g: 0, b: 0 });

let heatBucket = 0;
heatBucket = updateHeatBucket(heatBucket, 1600, 10000);
assert.equal(heatBucket, HEAT_BUCKET_MAX);
assert.equal(heatLimitedScale(heatBucket, 1600), 79);

const displayedMilliAmps = scaledMilliAmps(1600, heatLimitedScale(heatBucket, 1600));
assert.equal(displayedMilliAmps, 495);
heatBucket = updateHeatBucket(heatBucket, displayedMilliAmps, 1000);
assert.equal(heatBucket, 9988);

heatBucket = 0;
heatBucket = updateHeatBucket(heatBucket, 1000, 10000);
assert.equal(heatBucket, 2063);
assert.equal(heatLimitedScale(heatBucket, 1000), 229);

heatBucket = HEAT_BUCKET_MAX;
heatBucket = updateHeatBucket(heatBucket, 500, 10000);
assert.equal(heatBucket, 9980);
assert.equal(heatLimitedScale(heatBucket, 500), 255);

heatBucket = HEAT_BUCKET_MAX;
heatBucket = updateHeatBucket(heatBucket, 250, 1000);
assert.equal(heatBucket, 9498);

const standbyCurrent = estimateActiveColorMilliAmps(STANDBY_RED, STANDBY_GREEN, STANDBY_BLUE);
assert.equal(standbyCurrent, 41);
heatBucket = HEAT_BUCKET_MAX;
heatBucket = updateHeatBucket(heatBucket, standbyCurrent, 10000);
assert.equal(heatBucket, 800);
heatBucket = updateHeatBucket(heatBucket, standbyCurrent, 2000);
assert.equal(heatBucket, 0);

const fullWhiteCurrent = estimateMilliAmps(maskedWhiteFrame.channelTotal);
const fullWhiteHeatScale = heatLimitedScale(0, fullWhiteCurrent);
const fullWhiteScale = currentLimitedScale(fullWhiteCurrent, fullWhiteHeatScale);
const fullWhiteBudget = effectiveBudgetMilliAmps(fullWhiteCurrent, fullWhiteHeatScale, fullWhiteScale);
const fullWhiteLimited = applyPowerLimit(maskedWhiteFrame.leds, fullWhiteBudget, false);
const fullWhiteTotals = regionChannelTotals(fullWhiteLimited.leds);
assert.equal(fullWhiteCurrent, 3960);
assert.equal(fullWhiteScale, 103);
assert.equal(fullWhiteBudget, MAX_MILLIAMPS);
assert.equal(fullWhiteTotals[LED_REGION_BOTTOM], 0);
assert.equal(fullWhiteTotals[LED_REGION_SIDE], 0);
assert(fullWhiteTotals[LED_REGION_TOP] > 0);
assert.equal(estimateMilliAmps(fullWhiteLimited.channelTotal) <= MAX_MILLIAMPS, true);
assert(fullWhiteLimited.leds.filter((_, index) => isTopLed(index)).every((led) => led.r === led.g && led.g === led.b));
assert(fullWhiteLimited.leds.filter((_, index) => isTopLed(index)).every((led) => led.r >= 160 && led.r <= 175));
assert(fullWhiteLimited.leds.filter((_, index) => !isActiveLed(index)).every((led) => led.r === 0 && led.g === 0 && led.b === 0));

const topOnlyFrame = createRegionFrame({ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 });
const topOnlyCurrent = estimateMilliAmps(applyRegionMask(topOnlyFrame).channelTotal);
const coolTopOnly = applyPowerLimit(topOnlyFrame, MAX_MILLIAMPS, false);
const coolTopLed = coolTopOnly.leds.find((_, index) => isTopLed(index));
assert.equal(topOnlyCurrent, 2400);
assert(coolTopLed.r >= 160 && coolTopLed.r <= 175);
assert.equal(coolTopLed.r, coolTopLed.g);
assert.equal(coolTopLed.g, coolTopLed.b);

const hotTopHeatScale = heatLimitedScale(HEAT_BUCKET_MAX, topOnlyCurrent);
const hotTopScale = currentLimitedScale(topOnlyCurrent, hotTopHeatScale);
const hotTopBudget = effectiveBudgetMilliAmps(topOnlyCurrent, hotTopHeatScale, hotTopScale);
const hotTopOnly = applyPowerLimit(topOnlyFrame, hotTopBudget, false);
const hotTopLed = hotTopOnly.leds.find((_, index) => isTopLed(index));
const hotTopTotals = regionChannelTotals(hotTopOnly.leds);
assert(hotTopBudget < MAX_MILLIAMPS);
assert(estimateMilliAmps(hotTopOnly.channelTotal) <= hotTopBudget);
assert(hotTopLed.r < coolTopLed.r);
assert.equal(hotTopTotals[LED_REGION_SIDE], 0);
assert.equal(hotTopTotals[LED_REGION_BOTTOM], 0);

const squeezedWhite = applyPowerLimit(maskedWhiteFrame.leds, 1500, false);
const squeezedWhiteTotals = regionChannelTotals(squeezedWhite.leds);
assert.equal(squeezedWhiteTotals[LED_REGION_BOTTOM], 0);
assert.equal(squeezedWhiteTotals[LED_REGION_SIDE], 0);
assert(squeezedWhiteTotals[LED_REGION_TOP] > 0);
assert(estimateMilliAmps(squeezedWhite.channelTotal) <= 1500);

const mixedWhite = applyPowerLimit(maskedWhiteFrame.leds, 3000, false);
const mixedWhiteTotals = regionChannelTotals(mixedWhite.leds);
assert.equal(mixedWhiteTotals[LED_REGION_BOTTOM], 0);
assert(mixedWhiteTotals[LED_REGION_SIDE] > 0);
assert.equal(mixedWhiteTotals[LED_REGION_TOP], regionChannelTotals(topOnlyFrame)[LED_REGION_TOP]);
assert(estimateMilliAmps(mixedWhite.channelTotal) <= 3000);

const redBoostFrame = applyRegionMask(createFrame(0, 0, 0));
const boostedRed = applyPowerLimit(redBoostFrame.leds, 10, true);
const boostedRedTotals = regionChannelTotals(boostedRed.leds);
assert(boostedRedTotals[LED_REGION_TOP] > 0);
assert.equal(boostedRedTotals[LED_REGION_SIDE], 0);
assert.equal(boostedRedTotals[LED_REGION_BOTTOM], 0);
assert(boostedRed.leds.every((led, index) => !isActiveLed(index) || (led.g === 0 && led.b === 0)));
assert(boostedRed.leds.every((led, index) => isActiveLed(index) || (led.r === 0 && led.g === 0 && led.b === 0)));

const greenFrame = applyRegionMask(createFrame(0, 255, 0));
const limitedGreen = applyPowerLimit(greenFrame.leds, MAX_MILLIAMPS, false);
assert(limitedGreen.leds.every((led, index) => !isActiveLed(index) || (led.g >= led.r && led.g >= led.b)));
assert(limitedGreen.leds.every((led, index) => isActiveLed(index) || sumChannels([led]) === 0));
assert(limitedGreen.channelTotal <= milliAmpsToChannelBudget(MAX_MILLIAMPS));

const blueFrame = applyRegionMask(createFrame(0, 0, 255));
const limitedBlue = applyPowerLimit(blueFrame.leds, MAX_MILLIAMPS, false);
assert(limitedBlue.leds.every((led, index) => !isActiveLed(index) || (led.b >= led.r && led.b >= led.g)));
assert(limitedBlue.leds.every((led, index) => isActiveLed(index) || sumChannels([led]) === 0));
assert(limitedBlue.channelTotal <= milliAmpsToChannelBudget(MAX_MILLIAMPS));

const cyanFrame = applyRegionMask(createFrame(0, 255, 255));
const limitedCyan = applyPowerLimit(cyanFrame.leds, MAX_MILLIAMPS, false);
assert(limitedCyan.leds.every((led, index) => !isActiveLed(index) || (led.g >= led.r && led.b >= led.r)));
assert(limitedCyan.leds.every((led, index) => isActiveLed(index) || sumChannels([led]) === 0));
assert(limitedCyan.channelTotal <= milliAmpsToChannelBudget(MAX_MILLIAMPS));

const underBudgetFrame = applyRegionMask(createFrame(10, 20, 30));
const underBudget = applyPowerLimit(underBudgetFrame.leds, estimateMilliAmps(underBudgetFrame.channelTotal), false);
assert.deepEqual(underBudget.leds[0], { r: 9, g: 19, b: 29 });
assert.deepEqual(underBudget.leds[1], { r: 0, g: 0, b: 0 });

console.log('heat limiter math ok');
