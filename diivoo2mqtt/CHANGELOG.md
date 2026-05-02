# Changelog

## 0.1.0
- Erste veröffentlichte Version
- Node.js Backend mit MQTT Bridge
- Vue Web UI per Ingress
- Lokaler Build über Home Assistant Add-on Repository

## 0.1.1
- Fixed small readline bug

## 0.1.2
- Added missing readline import

## 0.1.3
- fixed socket io connection bug and fixed shutdown bug

## 0.1.4
- updated ui and added robust handling for socket.io disconnects

## 0.1.5
- added fix for socket.io (again)

## 0.1.6
- added gateway hello on startup, implement device persistence via DeviceStore, update README documentation, and include minor code refinements

## 0.1.7
- fixed persistant storage for homeassistant

## 0.1.8
- ✨ Massive "Plug & Play" update including automatic gateway discovery (mDNS), native Home Assistant 1-click OTA updates, a brand-new gateway UI, and diagnostic tools for unknown devices.

## 0.1.8.1
- small bug fix + gateway store

## 0.1.8.2
- small bug fix - send gateway status correctly - fix gateway dissapearing

## 0.1.9
- bug fix - removed recursive ota loop

## 0.1.9.1
- bug fix - removed recursive ota loop

## 0.1.10
- added option to ask gateway to ping url to find best ota url (mock url - to update olt gateway)

## 0.1.11
- added more sofisticated ip checking system for gateway ota

## 0.1.11.1
- fixed connection to supervisor 443 -> 80

## 0.1.12
- smal fix to update legacy gateway in homeassistant

## 0.1.12.1
- smal fix to update legacy gateway in homeassistant V2

## 0.1.13
- smal fix to update legacy gateway in homeassistant V3

## 0.1.14
- fixing ota update

## 0.1.14.1
- extended ping time

## 0.1.15
- fixed homeassistant ota update - prevent it from getting stuck

## 0.1.16
- added fix for mdns discovery problem

## 0.1.17
- added icon fix

## 0.1.18
- added option to delete manually added gateway

## 0.1.19
- fixed small bug where app would crash if no gateway was supplyed

## 0.1.20
- fixed on destroy function

## 0.1.21
- added log export feature

## 0.1.22
- fixed small bug in raindelay where trigger was not sent to update valvecomputer 

## 0.1.23
- fixed raindelay date and storage bug

## 0.1.24
- added new decoder insights to fix "mist" watering not working

## 0.1.25
- added mist feature to decodeStatusSourceByte

## 0.1.26
- updated timouts trying to fix tx crash

## 0.1.27
- added larger timeout

## 0.1.28
- switch to new radio queue

## 0.1.29
- readded changed because of merge error

## 0.1.30
- added missing imports

## 0.1.31
- fixed another merge conflict

## 0.1.32
- fixed ValveDeviceV4 refactor

## 0.1.33
- lowered ping count

## 0.1.34
- lowered ping count

## 0.1.35
- applied old ping version to current codebase

## 0.1.36
- new try to fix refresh trigger

## 0.1.37
- bug wrong channel! fixed stupid

## 0.1.38
- programm seems stable now + added device config editor

## 0.1.39
- changed vite config

## 0.1.40
- small fontend fix

## 0.1.41
- ui change: made button smaller

## 0.1.42
- added individual download option for join logs of unknown valve computers

## 0.1.43
- fixed bug where unknown devices were not logged and added decoded joinInfo to the log export

## 0.1.44
- temporarily disabled WT-07W support for local diagnostic testing

## 0.1.45
- added feature to remove paired device

## 0.1.46
- small bug fix

## 0.1.47
- added persistence for diagnostic logs including handshake packets

## 0.1.48
- testing

## 0.1.49
- fixed diagnostic logs 404 download error caused by absolute ingress paths
- grouped diagnostic log UI and download to export all packets for a specific unknown device as a single JSON

## 0.1.50
- fixed ui bug

## 0.1.51
- added 60-second debounce for writing devices and diagnostic logs to SD card to prevent wear
- fixed critical heartbeat loop causing UI disconnections every 15 seconds
- replaced synchronous disk writes with asynchronous writes to prevent blocking the event loop and delaying radio ACKs

## 0.1.52
- optimized frontend reactivity batching to fix UI jumping on reconnect

## 0.1.53
- fixed diagnostic logs listener stacking (was registered once per client connection, causing duplicate entries)
- pre-cache grouped diagnostic logs to eliminate brief duplicate row flicker

## 0.1.54
- fixed reconnect storm: removed custom reconnect logic that fought Socket.io's built-in exponential backoff, causing 40+ rapid connect/disconnect cycles after backend restarts

## 0.1.55
- simplified diagnostic log architecture: grouping now happens in hub.getDiagnosticSummary(), frontend only receives a lightweight per-device summary

## 0.1.56
- fixed small bug where ui crashed when decoding failed

## 0.1.57
- capped log length to 50

## 0.1.58
- limited diagnostic logs to packages with commands 0x01, 0x05, 0x06, 0x85, 0x86