#!/bin/bash
# Dubbelklik om FollowUp Prion te starten (macOS)
cd "$(dirname "$0")"
(sleep 1 && open "http://localhost:8080") &
python3 server.py
