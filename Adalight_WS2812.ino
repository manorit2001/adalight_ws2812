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
#define SATURATED_COLOR_SCALE 160

// Baudrate, higher rate allows faster refresh rate and more LEDs (defined in /etc/boblight.conf)
#define serialRate 500000

// Adalight sends a "Magic Word" (defined in /etc/boblight.conf) before sending the pixel data
uint8_t prefix[] = {'A', 'd', 'a'}, hi, lo, chk, i;

// Initialise LED-array
CRGB leds[NUM_LEDS];

void limitSaturatedColor(byte &r, byte &g, byte &b) {
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
  FastLED.showColor(CRGB(255, 0, 0));
  delay(500);
  FastLED.showColor(CRGB(0, 255, 0));
  delay(500);
  FastLED.showColor(CRGB(0, 0, 255));
  delay(500);
  FastLED.showColor(CRGB(0, 0, 0));
  
  Serial.begin(serialRate);
  // Send "Magic Word" string to host
  Serial.print("Ada\n");
}

void loop() { 
  // Wait for first byte of Magic Word
  for(i = 0; i < sizeof prefix; ++i) {
    waitLoop: while (!Serial.available()) ;;
    // Check next byte in Magic Word
    if(prefix[i] == Serial.read()) continue;
    // otherwise, start over
    i = 0;
    goto waitLoop;
  }
  
  // Hi, Lo, Checksum  
  while (!Serial.available()) ;;
  hi=Serial.read();
  while (!Serial.available()) ;;
  lo=Serial.read();
  while (!Serial.available()) ;;
  chk=Serial.read();
  
  // If checksum does not match go back to wait
  if (chk != (hi ^ lo ^ 0x55)) {
    i=0;
    goto waitLoop;
  }
  
  memset(leds, 0, NUM_LEDS * sizeof(struct CRGB));
  // Read the transmission data and set LED values
  for (uint8_t i = 0; i < NUM_LEDS; i++) {
    byte r, g, b;    
    while(!Serial.available());
    r = Serial.read();
    while(!Serial.available());
    g = Serial.read();
    while(!Serial.available());
    b = Serial.read();
    limitSaturatedColor(r, g, b);
    leds[i].r = r;
    leds[i].g = g;
    leds[i].b = b;
  }
  
  // Shows new values
  FastLED.show();
}
