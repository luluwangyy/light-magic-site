# Light Magic

Light Magic connects hand gestures, body poses and spoken phrases to an ETC Eos lighting console. I built it for *How to Make the Air Obey* at Barnard’s Movement Lab. The camera, microphone and cue sheet run in a browser. A local Python bridge sends lighting commands over Ethernet.

[Try the browser rehearsal](https://luluwangyy.github.io/light-magic-site/try/) · [Download the controller](https://luluwangyy.github.io/light-magic-site/downloads/light-magic-controller.zip) · [Project and videos](https://luluwangyy.github.io/lulu-wang-creative-tech-portfolio/projects/light-magic.html)

## Start on a PC or Mac

Extract the download and install Python 3.12. On Windows, open **Start Movement Gesture.bat**. On macOS, open a terminal in the extracted folder and run `sh "Start Movement Gesture.command"`. Keep the launcher running.

Open `http://127.0.0.1:8765/#session` in Chrome or Edge. Choose Camera, Speech only, or Camera + speech, then **Start rehearsal**. Allow camera and microphone access. The stage preview shows the saved lighting action. The **Try a mapping** buttons let you inspect a mapping independently of recognition.

For speech, run **Setup speech recognition.bat** on Windows or `sh "Setup speech recognition.command"` on macOS. Setup downloads the offline models. Restart the controller afterward. The short commands “White lights,” “Magic shift,” “Shield up,” “Take command,” and “Lights out” use the corresponding show phrase’s mapping.

## Set up the show

In **Cue sheet**, load *How to Make the Air Obey* for its gesture and phrase vocabulary. Assign each input to an existing cue, a channel’s settings, or a look with several channels. **Movement Lab channel looks → Preview on stage** shows the archived rig. **Use these looks** replaces the current assignments with those example looks, with an option to restore the earlier assignments.

| Camera input | How to perform it |
| --- | --- |
| Open palm | Extend the fingers of either hand |
| Fist | Fold the fingers into a closed fist |
| Fire | Extend thumb, index and middle fingers, with ring and little fingers folded |
| Ankh | Extend both arms sideways near shoulder height |

Hold the pose until the progress bar fills. Each continuous hold produces one event. Relax or change pose before repeating. Fire starts disabled until you assign and enable it. When Ankh is disabled, hand tracking skips body inference to reduce processing load.

## Connect to Eos

Connect the bridge computer to the console’s network. Open the intended show in Eos and enter its current IP in **Console**. The lab preset uses TCP port **3032**, **OSC 1.0 packet length**, and OSC receive/transmit enabled on the desk.

Use **Test connection**, then **Start console session** and confirm the console and show. Test a saved output and check the fixtures. Look tests and speech practice can be skipped explicitly for that session. Choose **Go live** to let fresh camera holds and speech matches send their assigned output.

Going live starts a new hold for static gestures. The pose must complete its full hold after that click. A two-second output gap is shared by gesture, speech and manual actions. A held pose does not repeatedly send commands. **Pause output** or **Esc** stops new automatic output. The console may retain manual levels and colors until you change them there.

## If recognition works but the lights do not change

Open **Why did this trigger send or stop?** in Session. It shows the recognized input, hold progress, the current blocker, the output queue and the last completed console write. **Copy diagnostics** and **Download diagnostics** create a report for troubleshooting.

In the camera panel, **Gesture debug → Send mapped output live** sends the selected saved mapping through the live output queue. It is available during a live console session and can change the physical lights. If it works while the camera fails, inspect the tracking and hold diagnostics. **Typed phrase test** in Speech checks the phrase mapping, with a separate button for an explicit live send.

Keep the controlling browser page visible. A disconnected camera, stopped microphone or expired browser session pauses automatic output. With Camera + speech selected, both inputs need to be current. For a gesture-only test, choose Camera.

A completed TCP write records what the bridge sent. Verify the cue and fixture response on Eos. The preview uses the archived Movement Lab layout and approximate beam shapes. Live channel settings depend on the active fixture patch.

## Saved work and another computer

Assignments and device settings live in `profile.json`; learned motions live in `custom-motions.json`. To move your setup, copy those files into the extracted controller folder on the other computer while it is stopped. Start the controller there, select the available devices and confirm the new console session.

The download includes the source, camera models and preview assets. Speech models install separately. For remote browser control through one bridge computer, see [shared live control](docs/shared-live-control.md).

## Development

Run `python -m unittest discover -s tests -v` and each `tests/*.mjs` file with Node.js. Tests use simulated consoles and do not establish physical fixture behavior. Third-party camera assets and checksums are listed in [the camera manifest](web/assets/manifest.json). Offline speech model sources are listed in [the Standard](speech-model.json) and [Enhanced](speech-enhanced-model.json) manifests.
