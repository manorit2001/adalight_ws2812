/*
 * Arduino interface for the use of WS2812 strip LEDs
 * Uses Adalight protocol and is compatible with Boblight, Prismatik etc...
 * "Magic Word" for synchronisation is 'Ada' followed by LED High, Low and Checksum
 * @author: Wifsimster <wifsimster@gmail.com> 
 * @library: FastLED v3.001
 * @date: 11/22/2015
 */
#include "FastLED.h"

#define NUM_LEDS 104
#define DATA_PIN 6
#define MAX_MILLIAMPS 1600
#define SATURATION_DIM_START 40
#define SATURATED_COLOR_SCALE 255
#define IDLE_TIMEOUT_MS 60000UL
#define STANDBY_RED 8
#define STANDBY_GREEN 0
#define STANDBY_BLUE 0
#define SUSTAINED_TARGET_MILLIAMPS 500
#define HEAT_BUCKET_MAX 10000UL
#define HEAT_STRESS_RANGE_MA (MAX_MILLIAMPS - SUSTAINED_TARGET_MILLIAMPS)
#define RED_COMPENSATION_BUDGET_DIVISOR 4
#define RED_COMPENSATION_MAX_PER_LED 16

enum LedRegion : uint8_t {
  LED_REGION_BOTTOM = 0,
  LED_REGION_SIDE = 1,
  LED_REGION_TOP = 2,
  LED_REGION_CORNER = 3,
  LED_REGION_INACTIVE = 255,
  LED_REGION_COUNT = 4,
};

const uint8_t REGION_WEIGHTS[LED_REGION_COUNT] = {2, 7, 36, 1};

// Baudrate, higher rate allows faster refresh rate and more LEDs (defined in /etc/boblight.conf)
#define serialRate 500000

// Adalight sends a "Magic Word" (defined in /etc/boblight.conf) before sending the pixel data
uint8_t prefix[] = {'A', 'd', 'a'}, hi, lo, chk, i;

// Initialise LED-array
CRGB leds[NUM_LEDS];
unsigned long lastDataAt = 0;
unsigned long lastFrameAt = 0;
uint16_t lastFrameMilliAmps = 0;
uint16_t heatBucket = 0;
bool standbyShown = false;

bool isBottomLed(uint8_t ledIndex) {
  return ledIndex <= 14 || (ledIndex >= 89 && ledIndex <= 103);
}

bool isSideLed(uint8_t ledIndex) {
  return (ledIndex >= 15 && ledIndex <= 31) || (ledIndex >= 72 && ledIndex <= 88);
}

bool isTopLed(uint8_t ledIndex) {
  return ledIndex >= 32 && ledIndex <= 71;
}

bool isCornerLed(uint8_t ledIndex) {
  return ledIndex == 12 || ledIndex == 15 || ledIndex == 31 || ledIndex == 32 ||
         ledIndex == 71 || ledIndex == 72 || ledIndex == 88 || ledIndex == 89;
}

bool isActiveLed(uint8_t ledIndex) {
  if (isTopLed(ledIndex)) {
    return true;
  }

  if (ledIndex >= 15 && ledIndex <= 31) {
    return ((ledIndex - 15) % 2) == 0;
  }

  if (ledIndex >= 72 && ledIndex <= 88) {
    return ((ledIndex - 72) % 2) == 0;
  }

  if (ledIndex <= 14) {
    return ((ledIndex - 0) % 2) == 0;
  }

  if (ledIndex >= 89 && ledIndex <= 103) {
    return ((ledIndex - 89) % 2) == 0;
  }

  return false;
}

uint8_t ledRegion(uint8_t ledIndex) {
  if (isCornerLed(ledIndex)) {
    return LED_REGION_CORNER;
  }

  if (isTopLed(ledIndex)) {
    return LED_REGION_TOP;
  }

  if (isSideLed(ledIndex)) {
    return LED_REGION_SIDE;
  }

  if (isBottomLed(ledIndex)) {
    return LED_REGION_BOTTOM;
  }

  return LED_REGION_INACTIVE;
}

uint8_t activeLedCount() {
  uint8_t count = 0;

  for (uint8_t ledIndex = 0; ledIndex < NUM_LEDS; ledIndex++) {
    if (isActiveLed(ledIndex)) {
      count++;
    }
  }

  return count;
}

uint8_t regionActiveLedCount(uint8_t region) {
  uint8_t count = 0;

  for (uint8_t ledIndex = 0; ledIndex < NUM_LEDS; ledIndex++) {
    if (ledRegion(ledIndex) == region && isActiveLed(ledIndex)) {
      count++;
    }
  }

  return count;
}

void showStandbyIfIdle() {
  if (!standbyShown && millis() - lastDataAt >= IDLE_TIMEOUT_MS) {
    unsigned long now = millis();
    updateHeatBucket(lastFrameMilliAmps, now - lastFrameAt);
    memset(leds, 0, NUM_LEDS * sizeof(struct CRGB));

    for (uint8_t i = 0; i < NUM_LEDS; i++) {
      if (!isActiveLed(i)) {
        continue;
      }

      leds[i] = CRGB(STANDBY_RED, STANDBY_GREEN, STANDBY_BLUE);
    }

    FastLED.show();
    recordPowerState(now, estimateActiveColorMilliAmps(STANDBY_RED, STANDBY_GREEN, STANDBY_BLUE));
    standbyShown = true;
  }
}

void waitForSerialData() {
  while (!Serial.available()) {
    showStandbyIfIdle();
  }
}

uint16_t estimateMilliAmps(uint32_t channelTotal) {
  return (channelTotal * 20UL) / 255UL;
}

uint16_t estimateColorMilliAmps(uint8_t ledCount, byte r, byte g, byte b) {
  return estimateMilliAmps((uint32_t)ledCount * (r + g + b));
}

uint16_t estimateActiveColorMilliAmps(byte r, byte g, byte b) {
  return estimateColorMilliAmps(activeLedCount(), r, g, b);
}

void recordPowerState(unsigned long now, uint16_t displayedMilliAmps) {
  lastFrameAt = now;
  lastFrameMilliAmps = displayedMilliAmps;
}

void updateHeatBucket(uint16_t estimatedMilliAmps, unsigned long elapsedMs) {
  if (elapsedMs == 0) {
    return;
  }

  if (estimatedMilliAmps > MAX_MILLIAMPS) {
    estimatedMilliAmps = MAX_MILLIAMPS;
  }

  if (estimatedMilliAmps > SUSTAINED_TARGET_MILLIAMPS) {
    uint16_t stress = estimatedMilliAmps - SUSTAINED_TARGET_MILLIAMPS;
    uint32_t heatAdd = ((((uint32_t)stress * stress) / HEAT_STRESS_RANGE_MA) * elapsedMs) / HEAT_STRESS_RANGE_MA;

    if (heatAdd > HEAT_BUCKET_MAX - heatBucket) {
      heatBucket = HEAT_BUCKET_MAX;
    } else {
      heatBucket += heatAdd;
    }
  } else {
    uint32_t heatDrop = ((uint32_t)(SUSTAINED_TARGET_MILLIAMPS - estimatedMilliAmps + 1) * elapsedMs) / SUSTAINED_TARGET_MILLIAMPS;

    if (heatDrop > heatBucket) {
      heatBucket = 0;
    } else {
      heatBucket -= heatDrop;
    }
  }
}

byte heatLimitedScale(uint16_t estimatedMilliAmps) {
  if (estimatedMilliAmps <= SUSTAINED_TARGET_MILLIAMPS || heatBucket == 0) {
    return 255;
  }

  uint16_t targetScale = ((uint32_t)SUSTAINED_TARGET_MILLIAMPS * 255UL) / estimatedMilliAmps;
  uint16_t scaleDrop = ((uint32_t)heatBucket * (255 - targetScale)) / HEAT_BUCKET_MAX;

  return 255 - scaleDrop;
}

uint16_t scaledMilliAmps(uint16_t estimatedMilliAmps, byte scale) {
  return ((uint32_t)estimatedMilliAmps * scale) / 255UL;
}

uint16_t effectiveBudgetMilliAmps(uint16_t estimatedMilliAmps, byte heatScale, byte scale) {
  if (scale < heatScale) {
    return MAX_MILLIAMPS;
  }

  return min(MAX_MILLIAMPS, scaledMilliAmps(estimatedMilliAmps, scale));
}

byte currentLimitedScale(uint16_t estimatedMilliAmps, byte heatScale) {
  if (estimatedMilliAmps <= MAX_MILLIAMPS) {
    return heatScale;
  }

  uint16_t maxScale = ((uint32_t)MAX_MILLIAMPS * 255UL) / estimatedMilliAmps;

  if (maxScale > 255) {
    maxScale = 255;
  }

  return min(heatScale, (byte)maxScale);
}

uint32_t milliAmpsToChannelBudget(uint16_t milliAmps) {
  return ((uint32_t)milliAmps * 255UL) / 20UL;
}

uint16_t addRedHeadroom(uint8_t ledIndex, uint16_t headroom) {
  uint16_t add = min((uint16_t)(255 - leds[ledIndex].r), headroom);

  leds[ledIndex].r += add;
  return add;
}

byte regionScaleFor(uint32_t requestedChannelTotal, uint32_t retainedChannelTotal) {
  if (requestedChannelTotal == 0 || retainedChannelTotal == 0) {
    return 0;
  }

  if (retainedChannelTotal >= requestedChannelTotal) {
    return 255;
  }

  uint32_t scale = (retainedChannelTotal * 255UL) / requestedChannelTotal;

  if (scale > 255UL) {
    scale = 255UL;
  }

  return (byte)scale;
}

void allocateWeightedRegionBudget(uint32_t requestedChannelTotals[], uint32_t retainedChannelTotals[], uint32_t budgetChannelTotal) {
  bool settledRegions[LED_REGION_COUNT] = {false, false, false, false};
  uint32_t remainingBudget = budgetChannelTotal;

  while (remainingBudget > 0) {
    uint64_t weightedDemand = 0;
    bool hasDemand = false;

    for (uint8_t region = 0; region < LED_REGION_COUNT; region++) {
      if (settledRegions[region] || retainedChannelTotals[region] >= requestedChannelTotals[region]) {
        continue;
      }

      weightedDemand += (uint64_t)requestedChannelTotals[region] * REGION_WEIGHTS[region];
      hasDemand = true;
    }

    if (!hasDemand || weightedDemand == 0) {
      return;
    }

    uint32_t shares[LED_REGION_COUNT] = {0, 0, 0, 0};
    uint32_t allocatedThisPass = 0;
    bool settledThisPass = false;

    for (uint8_t region = 0; region < LED_REGION_COUNT; region++) {
      if (settledRegions[region] || retainedChannelTotals[region] >= requestedChannelTotals[region]) {
        continue;
      }

      uint64_t weightedRequest = (uint64_t)requestedChannelTotals[region] * REGION_WEIGHTS[region];
      uint32_t share = (uint32_t)(((uint64_t)remainingBudget * weightedRequest) / weightedDemand);

      if (share >= requestedChannelTotals[region]) {
        retainedChannelTotals[region] = requestedChannelTotals[region];
        remainingBudget -= requestedChannelTotals[region];
        settledRegions[region] = true;
        settledThisPass = true;
      } else {
        shares[region] = share;
        allocatedThisPass += share;
      }
    }

    if (settledThisPass) {
      continue;
    }

    for (uint8_t region = 0; region < LED_REGION_COUNT; region++) {
      retainedChannelTotals[region] += shares[region];
    }

    if (allocatedThisPass > remainingBudget) {
      remainingBudget = 0;
    } else {
      remainingBudget -= allocatedThisPass;
    }

    const uint8_t remainderOrder[LED_REGION_COUNT] = {LED_REGION_TOP, LED_REGION_SIDE, LED_REGION_BOTTOM, LED_REGION_CORNER};

    for (uint8_t orderIndex = 0; orderIndex < LED_REGION_COUNT && remainingBudget > 0; orderIndex++) {
      uint8_t region = remainderOrder[orderIndex];

      if (retainedChannelTotals[region] < requestedChannelTotals[region]) {
        retainedChannelTotals[region]++;
        remainingBudget--;
      }
    }

    return;
  }
}

uint32_t applyPowerLimit(uint16_t budgetMilliAmps, bool compensateRed) {
  uint32_t requestedChannelTotals[LED_REGION_COUNT] = {0, 0, 0, 0};
  uint32_t retainedChannelTotals[LED_REGION_COUNT] = {0, 0, 0, 0};
  byte regionScales[LED_REGION_COUNT] = {0, 0, 0, 0};
  uint32_t budgetChannelTotal = milliAmpsToChannelBudget(budgetMilliAmps);

  for (uint8_t ledIndex = 0; ledIndex < NUM_LEDS; ledIndex++) {
    if (!isActiveLed(ledIndex)) {
      continue;
    }

    uint8_t region = ledRegion(ledIndex);

    requestedChannelTotals[region] += leds[ledIndex].r;
    requestedChannelTotals[region] += leds[ledIndex].g;
    requestedChannelTotals[region] += leds[ledIndex].b;
  }

  allocateWeightedRegionBudget(requestedChannelTotals, retainedChannelTotals, budgetChannelTotal);

  for (uint8_t region = 0; region < LED_REGION_COUNT; region++) {
    regionScales[region] = regionScaleFor(requestedChannelTotals[region], retainedChannelTotals[region]);
  }

  uint32_t displayedChannelTotal = 0;

  for (uint8_t ledIndex = 0; ledIndex < NUM_LEDS; ledIndex++) {
    if (!isActiveLed(ledIndex)) {
      continue;
    }

    uint8_t region = ledRegion(ledIndex);

    byte scale = regionScales[region];

    if (scale < 255) {
      leds[ledIndex].r = scale8(leds[ledIndex].r, scale);
      leds[ledIndex].g = scale8(leds[ledIndex].g, scale);
      leds[ledIndex].b = scale8(leds[ledIndex].b, scale);
    }

    displayedChannelTotal += leds[ledIndex].r;
    displayedChannelTotal += leds[ledIndex].g;
    displayedChannelTotal += leds[ledIndex].b;
  }

  if (!compensateRed) {
    return displayedChannelTotal;
  }

  uint32_t displayedBudgetChannelTotal = milliAmpsToChannelBudget(budgetMilliAmps);
  uint32_t remainingBudget = 0;

  if (displayedBudgetChannelTotal > displayedChannelTotal) {
    remainingBudget = displayedBudgetChannelTotal - displayedChannelTotal;
  }

  uint32_t boostBudget = remainingBudget / RED_COMPENSATION_BUDGET_DIVISOR;

  if (boostBudget == 0) {
    return displayedChannelTotal;
  }

  uint16_t perLedBoost = boostBudget / activeLedCount();

  if (perLedBoost == 0) {
    perLedBoost = 1;
  } else if (perLedBoost > RED_COMPENSATION_MAX_PER_LED) {
    perLedBoost = RED_COMPENSATION_MAX_PER_LED;
  }

  for (int8_t region = LED_REGION_TOP; region >= LED_REGION_BOTTOM && boostBudget > 0; region--) {
    for (uint8_t ledIndex = 0; ledIndex < NUM_LEDS && boostBudget > 0; ledIndex++) {
      if (ledRegion(ledIndex) != (uint8_t)region || !isActiveLed(ledIndex)) {
        continue;
      }

      uint16_t added = addRedHeadroom(ledIndex, min((uint32_t)perLedBoost, boostBudget));
      displayedChannelTotal += added;
      boostBudget -= added;
    }
  }

  return displayedChannelTotal;
}

void limitSaturatedColor(byte &r, byte &g, byte &b) {
  if (SATURATED_COLOR_SCALE == 255) {
    return;
  }

  byte maxChannel = max(r, max(g, b));
  byte minChannel = min(r, min(g, b));
  byte saturation = maxChannel - minChannel;

  if (saturation <= SATURATION_DIM_START) {
    return;
  }

  byte scale = 255 - ((uint16_t)(saturation - SATURATION_DIM_START) * (255 - SATURATED_COLOR_SCALE) / (255 - SATURATION_DIM_START));

  r = scale8(r, scale);
  g = scale8(g, scale);
  b = scale8(b, scale);
}

void setup() {
  // Use NEOPIXEL to keep true colors
  FastLED.addLeds<NEOPIXEL, DATA_PIN>(leds, NUM_LEDS);
  FastLED.setMaxPowerInVoltsAndMilliamps(5, MAX_MILLIAMPS);
  
  // Initial RGB flash
  FastLED.showColor(CRGB(10, 0, 0));
  delay(500);
  FastLED.showColor(CRGB(0, 10, 0));
  delay(500);
  FastLED.showColor(CRGB(0, 0, 10));
  delay(500);
  FastLED.showColor(CRGB(0, 0, 0));
  
  Serial.begin(serialRate);
  lastDataAt = millis();
  lastFrameAt = lastDataAt;
  lastFrameMilliAmps = 0;
  // Send "Magic Word" string to host
  Serial.print("Ada\n");
}

void loop() { 
  // Wait for first byte of Magic Word
  for(i = 0; i < sizeof prefix; ++i) {
    waitLoop: waitForSerialData();
    // Check next byte in Magic Word
    if(prefix[i] == Serial.read()) continue;
    // otherwise, start over
    i = 0;
    goto waitLoop;
  }
  
  // Hi, Lo, Checksum  
  waitForSerialData();
  hi=Serial.read();
  waitForSerialData();
  lo=Serial.read();
  waitForSerialData();
  chk=Serial.read();
  
  // If checksum does not match go back to wait
  if (chk != (hi ^ lo ^ 0x55)) {
    i=0;
    goto waitLoop;
  }
  
  memset(leds, 0, NUM_LEDS * sizeof(struct CRGB));
  uint32_t channelTotal = 0;
  // Read the transmission data and set LED values
  for (uint8_t i = 0; i < NUM_LEDS; i++) {
    byte r, g, b;    
    waitForSerialData();
    r = Serial.read();
    waitForSerialData();
    g = Serial.read();
    waitForSerialData();
    b = Serial.read();
    limitSaturatedColor(r, g, b);

    if (!isActiveLed(i)) {
      continue;
    }

    channelTotal += r;
    channelTotal += g;
    channelTotal += b;
    leds[i].r = r;
    leds[i].g = g;
    leds[i].b = b;
  }
  
  // Shows new values
  unsigned long now = millis();
  updateHeatBucket(lastFrameMilliAmps, now - lastFrameAt);
  uint16_t estimatedMilliAmps = estimateMilliAmps(channelTotal);
  byte heatScale = heatLimitedScale(estimatedMilliAmps);
  byte scale = currentLimitedScale(estimatedMilliAmps, heatScale);
  uint16_t budgetMilliAmps = effectiveBudgetMilliAmps(estimatedMilliAmps, heatScale, scale);
  uint32_t displayedChannelTotal = applyPowerLimit(budgetMilliAmps, scale < 255);
  FastLED.show();
  recordPowerState(now, estimateMilliAmps(displayedChannelTotal));
  lastDataAt = now;
  standbyShown = false;
}
