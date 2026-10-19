# Third-party code

- **fflate 0.8.2**, MIT, by Arjun Barrett. `vendor/fflate-0.8.2.js` is the unmodified UMD build from the npm registry package. Its MIT license is retained at `vendor/fflate-LICENSE`. Source: https://github.com/101arrowz/fflate/tree/v0.8.2 . The downloaded npm tarball was verified against the registry's SHA-512 integrity metadata before extraction. The library runs locally to read the DOCX ZIP container; there are no runtime CDN requests.
- **eSpeak NG 1.52**, GPL-3.0-or-later, by the eSpeak NG contributors. It was used as a generation tool with the `en-gb-x-rp` voice to create the pronunciation MP3s under `audio/`. The generator is `scripts/build_audio.py`; eSpeak NG is not included in the site and is not needed at runtime.
