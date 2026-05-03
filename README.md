<div align="center">
  <img src="diivoo2mqtt/icon.png" alt="diivoo2mqtt Logo" width="200" />
  <h1>diivoo2mqtt</h1>
  <p><em>Control your DIIVOO irrigation timers from Home Assistant – fully local, no cloud, no subscription.</em></p>

  [![Open your Home Assistant instance and add the repository](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FTechnerd-SG%2Fhassio-diivoo2mqtt)

  [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20this%20project-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/stefantechnerdsg)
</div>

---

**TL;DR –** Local-only control for DIIVOO irrigation timers via Home Assistant. No cloud, no account, no subscription. The radio protocol is ~95–98% reverse-engineered from scratch using logic analyzers and SPI captures over the course of more than a year. The **WT-07W** (1-zone), **WT-11W(1)** (3-zone), and **WT-13W** (4-zone) are fully supported. The 2-zone variant is still missing its device identifier – **if you own one, your help would be hugely appreciated** (more on that below).

---

## Why does this exist?

I bought a couple of DIIVOO irrigation timers because they're good hardware at a fair price. Then I found out the app needs their cloud to do anything. Turn it on, check the status, set a schedule – all of it goes through their servers somewhere in China. That bothered me enough to do something about it.

A logic analyzer, a lot of coffee, and some radio experiments later: I'd reverse-engineered the protocol the hub uses to talk to the valves over the air. This add-on is the result of that. It replaces the cloud completely and talks to your valves directly, from your own Home Assistant instance.

## Features – everything the DIIVOO cloud does, but local

This isn't a stripped-down hack. It replicates the full feature set of the original DIIVOO cloud app – entirely on your local network:

- **Turn valves on/off** with configurable default watering duration
- **Watering schedules** – set up your irrigation plans and let them run automatically
- **Rain delay / rain pause** – postpone scheduled watering when the weather doesn't cooperate
- **Real-time status** – remaining watering time, battery level, valve state – all updating live
- **Multi-gateway support** – run multiple gateways to cover larger gardens. This also ensures there's always a gateway in RX mode listening for valve responses while another one is busy transmitting commands
- **Auto-discovery** – your valves show up in Home Assistant as switches via MQTT, no manual YAML needed
- **OTA firmware updates** – update your gateway firmware from the HA UI with one click (after the initial USB flash)
- **Automatic gateway discovery** – flashed gateways announce themselves via mDNS and just show up
- **Built-in web UI** via Ingress – manage gateways, see device states, trigger diagnostics
- **WiFi setup portal** on the gateway itself – if the ESP32 can't connect, it opens an AP with a captive portal to configure credentials

## What you need

1. **A DIIVOO ESP32 gateway (WG03)** – the physical box that came with your timers. You'll flash it with custom firmware once using the [browser-based web flasher](https://technerd-sg.github.io/hassio-diivoo2mqtt/webflasher/)
2. **An MQTT broker** – the Mosquitto add-on in Home Assistant works perfectly

## Setup

Click the button at the top, or add this repository URL manually in the Home Assistant Add-on Store:

```
https://github.com/Technerd-SG/hassio-diivoo2mqtt
```

Then:

1. **Settings → Add-ons → Add-on Store**
2. Top right menu → **Repositories** → paste the URL above
3. Reload the page, find **diivoo2mqtt**, install it
4. Go to the **Configuration** tab, enter your MQTT broker details
5. Hit start – your valves should appear in Home Assistant within a few seconds

## How it works (for the curious)

The DIIVOO gateway is an ESP32 with a CMT2300A sub-GHz radio chip. The valves are battery-powered and sleep for about 100ms at a time, then wake up for less than half a millisecond to check if someone is talking to them. That's your entire window. You need to send a long enough preamble on exactly the right channel to land inside that sub-millisecond slot – miss it and the valve goes right back to sleep without ever hearing you.

This project replaces the original cloud hub. The flashed ESP32 becomes a transparent radio bridge over TCP. The add-on running on your Home Assistant box does everything the original hub did: it knows the channel codes, handles the timing, sends the right wakeup pings, and updates your device states.

```
Home Assistant  ↔  MQTT  ↔  diivoo2mqtt  ↔  ESP32 (TCP)  ↔  DIIVOO Valves (Radio)
```

## Supported hardware

| Model | Zones | Status |
|-------|-------|--------|
| WT-07W | 1 | ✅ Fully supported |
| WT-09W | 2 | ❓ Help wanted |
| WT-11W(1) | 3 | ✅ Fully supported |
| WT-13W | 4 | ✅ Fully supported |

The software already handles variable channel counts, so adding the 2-zone model is just a matter of identifying the right device bytes from a real pairing packet.

### 👋 Own a 2-zone DIIVOO timer?

There's a diagnostic export feature built into the web interface. The add-on captures what your valve sends during pairing, packages it up, and gives you a download link. You can then open a GitHub issue and attach it.

No technical knowledge needed – just pair the device, hit "Export log", and share it. That's all it takes.

---

## Support this project

This project is free and open source. If it saves you from the cloud and you want to say thanks, a coffee goes a long way:

<div align="center">

  [![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/stefantechnerdsg)

</div>

---

*This is an unofficial community project. Not affiliated with DIIVOO. Flash firmware and use this software at your own risk.*
