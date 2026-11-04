#!/usr/bin/env python3
"""Generate the Inpulse 300 MK2 mapping from the official Inpulse 300 mapping.

Reads the XML shipped with Mixxx, renames it, loads the MK2 script in addition to
the official one, rebinds SHIFT + Q to the tempo range cycle and adds SHIFT + SLIP
as the vinyl button. The output is committed so the project works without Mixxx
sources; rerun after a Mixxx upgrade.
"""
import re
import sys
from pathlib import Path

SOURCE = Path("/usr/share/mixxx/controllers/Hercules_DJControl_Inpulse_300.midi.xml")
TARGET = Path(__file__).resolve().parent.parent / "mixxx/controllers/Hercules_DJControl_Inpulse_300_MK2.midi.xml"
MK2_SCRIPT = "Hercules-DJControl-Inpulse-300-MK2-script.js"


def control(group, key, description, status, midino):
    return f"""			<control>
				<group>{group}</group>
				<key>{key}</key>
				<description>{description}</description>
				<status>{status}</status>
				<midino>{midino}</midino>
				<options>
					<script-binding />
				</options>
			</control>
"""


def main():
    xml = SOURCE.read_text(encoding="utf-8")

    xml = xml.replace("<name>Hercules DJControl Inpulse 300</name>",
                      "<name>Hercules DJControl Inpulse 300 MK2 (djing)</name>", 1)
    xml = xml.replace("<description>MIDI Preset for Hercules DJControl Inpulse 300</description>",
                      "<description>Official Inpulse 300 mapping plus MK2 buttons: "
                      "SHIFT + SLIP = vinyl mode, SHIFT + Q = tempo range</description>", 1)
    xml = xml.replace(
        '<file functionprefix="DJCi300" filename="Hercules-DJControl-Inpulse-300-script.js" />',
        '<file functionprefix="DJCi300" filename="Hercules-DJControl-Inpulse-300-script.js" />\n'
        f'			<file functionprefix="DJCi300MK2" filename="{MK2_SCRIPT}" />', 1)

    # SHIFT + Q: beatgrid alignment -> tempo range cycle (both decks)
    pattern = re.compile(
        r"(<control>\s*<group>\[(Channel[12])\]</group>\s*)<key>beats_translate_curpos</key>"
        r"(\s*<description>Shift \+ Q button</description>\s*<status>0x9[45]</status>"
        r"\s*<midino>0x02</midino>\s*<options>\s*)<normal />", re.S)
    xml, n = pattern.subn(r"\1<key>DJCi300MK2.rateRangeCycle</key>\3<script-binding />", xml)
    if n != 2:
        sys.exit(f"expected 2 Shift + Q controls, rewrote {n}")

    # SHIFT + SLIP: vinyl mode (the MK2 has no VINYL button)
    added = control("[Channel1]", "DJCi300MK2.vinylButton", "Shift + SLIP: Vinyl (scratch) mode", "0x94", "0x01") \
        + control("[Channel2]", "DJCi300MK2.vinylButton", "Shift + SLIP: Vinyl (scratch) mode", "0x95", "0x01")
    marker = "			<!--Vinyl button-->"
    if marker not in xml:
        sys.exit("vinyl marker not found")
    xml = xml.replace(marker, added + marker, 1)

    TARGET.write_text(xml, encoding="utf-8")
    print(f"wrote {TARGET.relative_to(Path.cwd()) if TARGET.is_relative_to(Path.cwd()) else TARGET}")


if __name__ == "__main__":
    main()
