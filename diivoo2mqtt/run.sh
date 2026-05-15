#!/usr/bin/with-contenv bashio
set -e

export WEB_PORT=8099
export MQTT_BROKER="mqtt://$(bashio::config 'mqtt_host'):$(bashio::config 'mqtt_port')"
export MQTT_USER="$(bashio::config 'mqtt_username')"
export MQTT_PASSWORD="$(bashio::config 'mqtt_password')"
export MQTT_LANG="$(bashio::config 'language')"
export GATEWAY_ID="$(bashio::config 'gateway_id')"
export GATEWAY_IP="$(bashio::config 'gateway_ip')"
export GATEWAY_PORT="$(bashio::config 'gateway_port')"
export NODE_ENV=production

cd /app/backend
node index.js