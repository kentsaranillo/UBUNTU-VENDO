# ESP device protocol

The device API is plain HTTP on the private customer network. Treat the provisioning key as an installer secret and the returned token as a per-device secret.

## 1. Provision once

```http
POST /api/device/provision
X-Provision-Key: <site provision key>
Content-Type: application/json

{
  "hardware_id": "ESP8266-AABBCC",
  "name": "Front Counter",
  "coin_pin": 2,
  "enable_pin": 15
}
```

Persist the returned `token`. Provisioning the same `hardware_id` again rotates the token, which supports a total firmware wipe without creating a duplicate station.

## 2. Heartbeat every 15 seconds

```http
POST /api/device/heartbeat
X-Vendo-Device: ESP8266-AABBCC
Authorization: Bearer <device token>
Content-Type: application/json

{"firmware_version":"0.1.0","ack_command_ids":[]}
```

The response contains:

- `coin_slot_enabled`: drive the enable/set output only when true
- `active_session_id`: the customer lease receiving pulses
- `config`: assigned coin and enable pins plus config version
- `commands`: restart and refresh commands queued by the administrator

Fail closed: if two consecutive heartbeats fail, immediately disable the coin slot. Never leave the acceptor enabled because WiFi is unavailable.

## 3. Submit each coin pulse

```http
POST /api/device/pulse
X-Vendo-Device: ESP8266-AABBCC
Authorization: Bearer <device token>
Content-Type: application/json

{"pulse_id":"boot-7-1042","value_centavos":100}
```

`pulse_id` must be unique for that device. Store unacknowledged pulses in flash and retry the same ID after reconnecting. The server uniqueness constraint makes retries idempotent.

Debounce at the device and convert the acceptor pulse train into one denomination event. The server adds every event to the session total and recomputes the best configured rate combination.

## 4. Complete early (optional)

```http
POST /api/device/complete
X-Vendo-Device: ESP8266-AABBCC
Authorization: Bearer <device token>
Content-Type: application/json

{"session_id":123}
```

Normally the phone's **Done** button completes the session. If neither the phone nor ESP sends complete, the controller automatically credits a paid session when its 60-second lease expires. An empty lease simply closes and releases the slot.

## Electrical notes

- Isolate the coin acceptor's 12 V pulse line with an optocoupler or proper level shifter. Never connect it directly to an ESP GPIO.
- Common NodeMCU labels: D4 is GPIO2 and D8 is GPIO15. Both are boot-strap pins; GPIO2 must stay high and GPIO15 low during boot. Design the driver so it cannot change those boot levels.
- The coin-enable line should use a transistor/relay driver and default to disabled during reset.
- For new boards, prefer non-strap GPIOs or ESP32 pins and keep the assignments configurable from the controller.

