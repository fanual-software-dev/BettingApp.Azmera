# Reference sound and flight animation

The user supplied `2026-11-07 13-25-49.mkv` and requested its audio and motion. The recording's first approximately 16.6 seconds are silent. Public assets contain only trimmed audio, never video frames or desktop imagery.

- Countdown loop: 17.2–22.7 seconds of the supplied recording.
- Flight loop: 23.7–30.7 seconds of the supplied recording.
- The end and beginning of each excerpt are crossfaded for 250 ms, resulting in 5.25-second and 6.75-second loops. Audio is encoded as small MP3 files and decoded with Web Audio.
- Both original games use these loops. The existing separate synthesized crash boom remains; it only plays on an observed live crash transition. Existing mute persistence, background/close silence and stale-connection suppression remain.
- If an audio asset cannot load or decode, the prior synthesized soundtrack remains as fallback. Playback does not block game updates, and no microphone permission is requested.

The aircraft takes six seconds to climb from bottom-left to upper-right. After arrival it descends and rises smoothly every six seconds, by approximately 32% of stage height, while staying near the right edge. The trail follows the moving aircraft. Motion uses elapsed server round time, so reconnecting does not restart the climb. Reduced-motion preferences suppress animated travel. Game odds and settlement timing are unchanged.
