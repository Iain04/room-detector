@echo off
rem Run idf.py from a normal cmd window (no ESP-IDF terminal needed).
rem Usage (from a firmware project folder):  ..\..\idf build
rem                                           ..\..\idf -p COM4 flash monitor
powershell -NoProfile -ExecutionPolicy Bypass -Command ". 'C:\Espressif\tools\Microsoft.v6.1.PowerShell_profile.ps1' *> $null; idf.py %*; exit $LASTEXITCODE"
