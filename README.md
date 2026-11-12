# Floor Plan

Scan your home with your phone's camera and get a clean 2D floor plan as a PDF. Everything runs on the phone: the scan, the plan and the PDF never leave it.

**Open:** https://lienardquentin.github.io/floorplan/ in Chrome on an Android phone with Google Play Services for AR.

## How it works

1. Point the phone at the floor until the ring appears.
2. Tap **Add corner** at each corner of a room, where the wall meets the floor, going round in order, then **Close room** and name it.
3. Walk to the next room and carry on: one session for the whole home keeps the rooms lined up.
4. **Doorway**: tap both sides of each opening.
5. **Finish**: the plan appears with room areas and wall lengths. **Save PDF** puts an A4 plan, at a standard scale, in your Downloads.

The page uses WebXR hit tests (ARCore underneath) to place each tap on the floor in metres. Walls within 10° of square are straightened, corners of neighbouring rooms tapped within 8 cm of each other are merged, and doorways are moved onto the nearest wall. Rooms from separate scans each have their own frame, so they're placed by hand: drag them on the plan and turn them a quarter at a time.

Expect walls accurate to a few centimetres in good light. It's a handy plan, not a surveyor's.

Built with [three.js](https://threejs.org) and [jsPDF](https://github.com/parallax/jsPDF).
