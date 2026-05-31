import assert from 'node:assert/strict';

const NUM_LEDS = 104;
const MAX_MILLIAMPS = 1600;
const SUSTAINED_TARGET_MILLIAMPS = 500;
const HEAT_BUCKET_MAX = 10000;
const HEAT_STRESS_RANGE_MA = MAX_MILLIAMPS - SUSTAINED_TARGET_MILLIAMPS;
const STANDBY_RED = 8;
const STANDBY_GREEN = 0;
const STANDBY_BLUE = 0;

function estimateMilliAmps(channelTotal) {
  return Math.floor((channelTotal * 20) / 255);
}

function estimateColorMilliAmps(r, g, b) {
  return estimateMilliAmps(NUM_LEDS * (r + g + b));
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

assert.equal(estimateMilliAmps(255), 20);
assert.equal(estimateMilliAmps(255 * 3 * 104), 6240);

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

const standbyCurrent = estimateColorMilliAmps(STANDBY_RED, STANDBY_GREEN, STANDBY_BLUE);
assert.equal(standbyCurrent, 65);
heatBucket = HEAT_BUCKET_MAX;
heatBucket = updateHeatBucket(heatBucket, standbyCurrent, 10000);
assert.equal(heatBucket, 1280);
heatBucket = updateHeatBucket(heatBucket, standbyCurrent, 2000);
assert.equal(heatBucket, 0);

console.log('heat limiter math ok');
