# diivoo2mqtt

A Home Assistant add-on for running DIIVOO water timers locally over MQTT.

DIIVOO's stock setup depends on the vendor cloud. This project takes a different approach: I reverse-engineered most of the protocol and built custom firmware for the ESP32 gateway that comes with the system. The Node.js service in this repository talks to that gateway locally and publishes the devices to Home Assistant through MQTT.

## Features

- **Local control** – no cloud connection required for normal operation
- **MQTT auto-discovery** – valves, battery levels, and status entities show up automatically in Home Assistant
- **Home Assistant add-on** – runs as a regular add-on managed by the Home Assistant Supervisor

## Requirements

1. A DIIVOO ESP32 gateway flashed with the custom firmware: `[Link to ESP firmware repo]`
2. An MQTT broker running in Home Assistant, for example the Mosquitto add-on

## Installation

You can install this add-on through the Home Assistant Add-on Store by adding this repository as a custom repository.

1. In Home Assistant, go to **Settings** → **Add-ons**
2. Open the **Add-on Store**
3. Open the menu in the top right and select **Repositories**
4. Add this repository URL: `https://github.com/Technerd-SG/hassio-diivoo2mqtt`
5. Reload the page
6. Find **diivoo2mqtt** in the list and install it
7. Open the **Configuration** tab, enter the IP address of your gateway, and start the add-on

## Architecture

`DIIVOO timer (RF) <--> custom ESP32 gateway <--> diivoo2mqtt <--> MQTT broker <--> Home Assistant`

---

This is an unofficial community project and is not affiliated with DIIVOO. Use it at your own risk.