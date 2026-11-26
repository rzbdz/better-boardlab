# Firmware

Firmware this distribution ships, which boardd loads onto boards. `firmware.json` registers each file with its SoC,
purpose, path and sha256; boardd checks the sha256 before every load and refuses a file that does not match. A
distribution may ship none: a vendor's firmware belongs in that vendor's module market, which adds its files at start
and lists them the same way (`boardlab firmware`).

To replace or add a file: put it here, add or update its entry in `firmware.json` (with the new sha256), and say where
it comes from in this file.
