"""Generate the embedded JavaScript from the published aggregate game tables."""
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
CLASSES = ("Assassin", "Brawler", "Chanter", "Gladiator", "Ranger", "Sorcerer",
           "Spiritmaster", "Templar", "Cleric")


def read_table(path):
    return json.loads((ROOT / "reference" / path).read_text(encoding="utf-8"))


def main():
    guides = {name: read_table(f"classes/{name}.json") for name in CLASSES}
    payload = {"guides": guides, "equipment": read_table("equipment.json")}
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    build = ROOT / "build"
    build.mkdir(exist_ok=True)
    (build / "data.js").write_bytes(("window.AION_CLASS_DATA = " + data + ";\r\n").encode("utf-8"))


if __name__ == "__main__":
    main()
