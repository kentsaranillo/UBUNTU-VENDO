# VendoOS fleet firmware

Build targets and release images:

- `VendoOS-ESP8266-0.2.14.bin` for NodeMCU ESP8266 Wi-Fi. Coin input D4/GPIO2, enable output D8/GPIO15.
- `VendoOS-ESP32-0.2.14.bin` for generic ESP32 DevKit Wi-Fi. Coin input GPIO27, enable output GPIO26.
- `VendoOS-ESP8266-W5500-0.3.4.bin` for NodeMCU ESP8266 with W5500 Ethernet. Coin input D4/GPIO2, enable output D8/GPIO15.

Wi-Fi and Ethernet use the station network's DHCP gateway as the controller address on port 3080. Connect the station to a customer VLAN whose gateway runs VendoOS. For Wi-Fi setup, use `VendoOS-Setup-XXXX` if the board cannot join its default SSID. The station then provisions, appears in **Stations**, and accepts remote configuration and OTA releases.

The enable output always starts OFF and is forced OFF after 30 seconds without a successful heartbeat. Isolate a 12 V coin acceptor with an optocoupler and drive its inhibit/enable input through a suitable transistor or relay circuit.

Build with PlatformIO. Supply the server provisioning key at build time for first-time enrollment and for OTA signature verification. Builds without the installation key can keep using an existing device token, but cannot enroll on a controller that requires the installation key or verify releases signed with it.

```sh
PLATFORMIO_BUILD_FLAGS='-D VENDO_PROVISION_KEY=\"your-key\"' pio run
```
