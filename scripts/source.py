import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory


REQUEST_SECONDS = "10"


def check(config: Path) -> None:
    project = json.loads(config.read_text())
    if project.get("revision") == "target":
        return

    root = (config.parent / project.get("root", ".")).resolve()
    if not root.is_dir():
        raise SystemExit(f"Target source is missing: {root}")
    sources = project.get("sources", [])
    if not sources:
        raise SystemExit("Source projects need declared source files")
    for source in sources:
        path = root / source
        if not path.exists():
            raise SystemExit(f"Target source file is missing: {path}")
    if project.get("dockerfile"):
        recipe = (config.parent / project["dockerfile"]).resolve()
        if not recipe.is_file():
            raise SystemExit(f"Project Dockerfile is missing: {recipe}")
    if project.get("revision", "git") != "git":
        return

    status = subprocess.run(
        ["git", "-C", str(root), "status", "--porcelain", "--untracked-files=normal"],
        capture_output=True,
        text=True,
        check=True,
    )
    if status.stdout.strip():
        raise SystemExit(f"Target source checkout is not clean: {root}")
    deployment = project.get("deployment") or {}
    if not deployment.get("url"):
        return

    commit = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    with TemporaryDirectory() as directory:
        headers = Path(directory) / "headers"
        body = Path(directory) / "body"
        subprocess.run(
            [
                "curl",
                "-fsS",
                "--max-time",
                REQUEST_SECONDS,
                "-H",
                "Cache-Control: no-cache",
                "-D",
                str(headers),
                "-o",
                str(body),
                deployment["url"],
            ],
            check=True,
        )
        revision = next(
            (
                line.split(":", 1)[1].strip()
                for line in headers.read_text().splitlines()
                if line.lower().startswith("x-quaz-revision:")
            ),
            None,
        )
        if not revision:
            revision = json.loads(body.read_text()).get("revision")
    if revision != commit:
        raise SystemExit("Target source checkout does not match deployed revision")


if __name__ == "__main__":
    check(Path(sys.argv[1]))
