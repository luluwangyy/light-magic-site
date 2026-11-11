# Light Magic

Light Magic turns gestures and spoken phrases into lighting commands. I built it for [How to Make the Air Obey – Light Program](https://luluwangyy.github.io/lulu-wang-creative-tech-portfolio/projects/light-magic.html) at Barnard’s Movement Lab.

## Try it in your browser

Open the [browser rehearsal](https://luluwangyy.github.io/light-magic-site/try/) on a PC or Mac. Click **Open palm** to see the stage light up, then try **Fist** for a blackout. In the Speech panel, try typing “Let there be light” or “Stand down.” Start the camera to try palm and fist tracking. You can also use the microphone if your browser supports on-device speech recognition.

The preview simulates the Movement Lab’s lighting layout. It runs without an install or a console connection.

## Use it with an ETC Eos console

Live control runs through a small Python bridge on a computer connected to the console’s network. The controller lives in a [private repository](https://github.com/luluwangyy/light-magic/tree/revised) and requires repository access.

1. Download the controller and install Python 3.10 or later. On Windows, open **Start Movement Gesture.bat**. On macOS, run `sh "Start Movement Gesture.command"` from the project folder.
2. For voice input, run the matching **Setup speech recognition** script and restart the controller. The setup needs internet access. Recognition runs offline afterward.
3. On the bridge computer, open [the local controller](http://127.0.0.1:8765/) in Chrome or Edge. Choose camera, speech, or both in **Session**, then start a rehearsal to check recognition.
4. In **Cue sheet**, assign each trigger to an existing Eos cue or channel action. In **Console**, enter the desk’s IP address, TCP port, and OSC framing. Use **Test connection**, confirm the show, and verify each mapped output at the desk before choosing **Go live**. Press **Esc** or **Pause output** to stop new commands.

See the [controller README](https://github.com/luluwangyy/light-magic/blob/revised/README.md) for speech setup details and [shared live control](https://github.com/luluwangyy/light-magic/blob/revised/docs/shared-live-control.md) to connect from another computer.
