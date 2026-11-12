#!/bin/bash
# Dubbelklik om FollowUp Prion te starten (macOS)
cd "$(dirname "$0")"
(sleep 1 && open "http://localhost:8081") &
python3 server.py
