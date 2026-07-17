# Diivoo2MQTT

## Konfiguration

### mqtt_host
Hostname des MQTT-Brokers, z. B. `core-mosquitto`

### mqtt_port
Port des MQTT-Brokers, z. B. `1883`

### mqtt_username
Optionaler MQTT-Benutzername

### mqtt_password
Optionales MQTT-Passwort

### ota_host
Optionale LAN-IP-Adresse oder lokaler Hostname des Home-Assistant-Hosts, zum Beispiel `10.0.0.10`. Diese Adresse wird vom ESP32 verwendet, um OTA-Firmware über Port 8099 abzurufen. Ohne Angabe versucht das Add-on, die Adresse automatisch aus der TCP-Verbindung abzuleiten; in einer Docker-Bridge kann das eine für den ESP32 unerreichbare `172.x.x.x`-Adresse sein.

### gateway_id
ID des DIIVOO Gateways, z. B. `gw1`

### gateway_ip
IP-Adresse des Gateways im lokalen Netzwerk

### gateway_port
Port des Gateways, standardmäßig `8080`

## Oberfläche
Die Weboberfläche wird über Ingress direkt in Home Assistant geöffnet.