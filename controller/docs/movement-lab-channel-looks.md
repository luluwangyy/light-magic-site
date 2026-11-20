# How to Make the Air Obey

The Movement Lab design uses the two ceiling rows, channels 1–18, and the three directional fixtures on the back wall, channels 28, 30, and 32. Channel 31 stays dark in these looks because its mirror aim needs to be set on site. Every look specifies the intensity of all 22 archived show channels. Channels omitted from the table go to 0%. The blackout covers the show rig.

| Trigger | Look | Channels and intensity | Color and beam |
| --- | --- | --- | --- |
| Open palm | Revealing light | 1–18 at 78%, 28/30/32 at 32% | Warm white across the grid with a soft amber edge |
| Fist or “Stand down” | Blackout | All 22 show channels at 0% | Dark stage |
| Fire gesture | Fire state | 7–8 at 30%, 9–12 at 78%, 13–16 at 58%, 28/30/32 at 26% | Amber at center builds into orange and red upstage |
| Ankh pose | Ceremonial halo | 9–10 at 56%, 7–8 and 11–12 at 40%, 13–14 at 23% | Warm center with symmetrical lavender pools |
| “Let there be light” | White light | 1–18 at 66% | Even neutral white across both ceiling rows |
| “Abracadabra” | Transformation | 5–16 at 60%, 28/32 at 27% | Cyan on the odd row and magenta on the even row, echoed at the back |
| “They shall not pass” | Red barrier | 5–8 at 78% | Concentrated red across the grid on the audience side of center |
| “At my command” | Authoritarian state | 9–10 at 74%, 15–16 at 24% | Narrow cold white at center with a low blue pair upstage |

In **Cue sheet → Movement Lab channel looks**, pick a look and select **Preview on stage**. **Use these looks** assigns the vocabulary. **Restore earlier assignments** brings back the previous setup. You can also choose **Channel look** for an individual gesture or phrase and edit its channels. “At my command” matches at the start of a longer passage.

Eos accepts direct OSC intensity messages over Ethernet. For example, send the OSC address `/eos/chan/9/at` with a float argument of `30.0` to request Channel 9 at 30%. A look sends the addressed channel messages over the same TCP connection and uses the controller’s spacing between actions. Check that OSC receive is enabled and that the port and TCP framing match Eos. The console then controls the fixtures using its patch. [ETC OSC Message Structure](https://www.etcconnect.com/webdocs/Controls/EosFamilyOnlineHelp/en/Content/22_Show_Control/08_OSC/About_OSC/OSC_Message_Structure.htm) · [ETC OSC Setup](https://www.etcconnect.com/WebDocs/Controls/EosFamilyOnlineHelp/en/Content/22_Show_Control/08_OSC/Using_OSC_with_Eos/Eos_OSC_Setup.htm)

The stage preview shows approximate beam shapes on the archived map. Verify the active show patch, color, zoom direction, and visible results at the console before live use.
