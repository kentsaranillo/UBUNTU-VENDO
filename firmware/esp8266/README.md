# ESP8266 reference firmware

Build with PlatformIO:

```sh
pio run
pio run --target upload --upload-port /dev/ttyUSB0
```

Before the first fleet build, set `WIFI_SSID`, `WIFI_PASSWORD`, and `PROVISION_KEY` in `debian_vendo.ino`. Leave `SERVER_BASE_OVERRIDE` blank for normal installations: the ESP discovers VendoOS at the DHCP gateway on port 3080. The resulting binary can be flashed unchanged to every ESP at the site.

On first boot the ESP generates its hardware ID, provisions itself, is assigned to the customer zone matching its source address, becomes that zone's default station when it is the first unit, and then heartbeats every 15 seconds. A new VLAN only needs to be created in the admin dashboard; its hardware ID and station name can be left blank.

This reference treats each isolated input pulse as PHP 1. If the coin acceptor uses another pulse mapping, change `VALUE_PER_PULSE_CENTAVOS` or group the pulse train before calling `sendPulse()`.

The sample is deliberately fail-closed: D8 is low at boot and is disabled after 30 seconds without a successful controller heartbeat. For a production PCB, use safer non-strap GPIOs and persist a small retry queue so already accepted pulses survive a power loss.
