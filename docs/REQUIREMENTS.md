# System requirements

Jimmy adapts to the machine it runs on: the scheduler (`server/scheduler.js`) sizes every kind of background work
from the machine's cores, memory and graphics card, and from what the person at the keyboard is doing. These are
the machines it is built and tested for. They stay at or below what Adobe asks for Premiere Pro and After Effects
(After Effects: 16 GB of memory at the least; Premiere Pro: 8 GB, 16 GB for HD footage).

|                | Minimum                                             | Recommended                                                  |
|----------------|-----------------------------------------------------|--------------------------------------------------------------|
| System         | Windows 10 (22H2) or 11, 64-bit · macOS 12 Monterey | Windows 11 · macOS 14 or later                               |
| Processor      | 4 cores / 8 threads (Intel 8th gen, AMD Ryzen 2000, Apple M1) | 8 cores / 16 threads or more (Intel 12th gen, Ryzen 5000, Apple M-series Pro) |
| Memory         | 8 GB (HD timelines, one export at a time)           | 16 GB for HD, 32 GB for 4K footage with several projects open |
| Graphics       | Any with DirectX 12 or Metal (integrated is fine)   | A card with a hardware video encoder (NVIDIA, AMD, Intel Quick Sync, Apple) and 4 GB of its own memory |
| Disk           | 10 GB free for the app and its cache                | An SSD for the cache (Settings › Storage), 50 GB or more free |
| Display        | 1366 × 768                                          | 1920 × 1080 or larger                                        |

## How Jimmy fits itself to a smaller machine

- **Render slots** come from the cores (Settings › Performance › usage) and the memory, one per 4 threads and per
  3 GB (`renderSlots` in `server/ffmpeg.js`): 1 on a 4-core, 8 GB laptop, 4 on a 24-thread, 48 GB one.
- **Exports on the graphics card** hold about 3 GB each, so their number follows the memory too (1–4).
- **The render engine** keeps each chunk near 1 GB: it renders fewer frames side by side for 4K footage than for HD.
- **Memory running low** (under about 15% free) halves the background work; very low (8%) leaves one job running.
- **The person at the keyboard**: while editing, background work uses about 70% of what it could; while playing or
  scrubbing about a third; after 20 s without a click or key, all of it.
- **On battery** it halves again; pre-rendering waits for the charger unless Settings say otherwise.
- **Background work runs below normal priority** (ffmpeg, the render engine's threads), so a click always comes first.
