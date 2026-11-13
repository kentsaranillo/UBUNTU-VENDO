# VendoOS fleet firmware

Build targets and release images:

- `VendoOS-ESP8266-0.2.15.bin` for NodeMCU ESP8266 Wi-Fi. Coin input D4/GPIO2, enable output D8/GPIO15.
- `VendoOS-ESP32-0.2.15.bin` for generic ESP32 DevKit Wi-Fi. Coin input GPIO27, enable output GPIO26.
- `VendoOS-ESP8266-W5500-0.3.5.bin` for NodeMCU ESP8266 with W5500 Ethernet. Coin input D4/GPIO2, enable output D8/GPIO15.

Wi-Fi and Ethernet use the station network's DHCP gateway as the controller address on port 3080. Connect the station to a customer VLAN whose gateway runs VendoOS. For Wi-Fi setup, use `VendoOS-Setup-XXXX` if the board cannot join its default SSID. The station then provisions, appears in **Stations**, and accepts remote configuration and OTA releases.

The enable output always starts OFF and is forced OFF after 30 seconds without a successful heartbeat. Isolate a 12 V coin acceptor with an optocoupler and drive its inhibit/enable input through a suitable transistor or relay circuit.

Recovery builds retry disconnected networks at 30-second intervals after initial setup. They enable the ESP8266 watchdog and a 60-second ESP32 task watchdog after setup completes. After at least 30 minutes of uptime and 10 minutes without a successful heartbeat, recovery can restart an idle board with its coin output OFF. Three consecutive recovery restarts are allowed, with the counter stored in LittleFS. Ten minutes of healthy heartbeats resets the limit. Failure to write the restart counter defers the restart.

Remote restart commands and OTA updates wait while the coin slot is enabled or pulses are pending. Daily scheduled restarts are disabled. Coin pulses are currently buffered in RAM. Watchdog resets and power loss can still lose unreported pulses, and existing pulse handling can discard pulses after the slot closes. Durable accounting across resets requires a session-bound persistent pulse queue and server support, which this release does not implement. Hardware fault recovery needs bench verification before fleet rollout.

Build with PlatformIO. Supply the server provisioning key at build time for first-time enrollment and for OTA signature verification. Builds without the installation key can keep using an existing device token, but cannot enroll on a controller that requires the installation key or verify releases signed with it.

```sh
PLATFORMIO_BUILD_FLAGS='-D VENDO_PROVISION_KEY=\"your-key\"' pio run
```
