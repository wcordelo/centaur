"""CLI for the Quick static-site deploy tool."""

import base64
import json
from pathlib import Path

import typer
from rich.console import Console

from centaur_sdk import Table

app = typer.Typer(name="quick", help="Deploy static web artifacts (HTML/JS/CSS)")
console = Console()

# Text extensions are sent as utf-8; everything else is base64-encoded.
_TEXT_EXT = {
    ".html",
    ".htm",
    ".css",
    ".js",
    ".mjs",
    ".cjs",
    ".json",
    ".map",
    ".txt",
    ".xml",
    ".csv",
    ".svg",
}


def get_client():
    """Load .env (local/standalone use) and return a QuickClient."""
    from dotenv import load_dotenv

    cli_env = Path(__file__).parent / ".env"
    repo_env = Path(__file__).parent.parent.parent.parent / ".env"
    for env_file in (cli_env, repo_env):
        if env_file.exists():
            load_dotenv(env_file)
            break

    from .client import QuickClient

    return QuickClient()


def _collect_files(directory: Path) -> list[dict[str, str]]:
    if not directory.is_dir():
        raise typer.BadParameter(f"{directory} is not a directory")
    files: list[dict[str, str]] = []
    for path in sorted(p for p in directory.rglob("*") if p.is_file()):
        rel = path.relative_to(directory).as_posix()
        if path.suffix.lower() in _TEXT_EXT:
            files.append({"path": rel, "content": path.read_text(encoding="utf-8")})
        else:
            files.append(
                {
                    "path": rel,
                    "content": base64.b64encode(path.read_bytes()).decode("ascii"),
                    "encoding": "base64",
                }
            )
    if not files:
        raise typer.BadParameter(f"no files found under {directory}")
    return files


@app.command()
def deploy(
    site_id: str = typer.Argument(..., help="Slug for the site URL (DNS label)"),
    directory: str = typer.Argument(..., help="Directory of static files to deploy"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Deploy a directory of static files to the Quick platform."""
    client = get_client()
    files = _collect_files(Path(directory))
    result = client.deploy_artifact(site_id, files)
    if json_output:
        print(json.dumps(result, indent=2))
        return
    console.print(f"[green]Deployed[/green] {result['file_count']} files -> {result['url']}")


@app.command(name="list")
def list_sites(
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """List sites deployed to the Quick platform."""
    client = get_client()
    result = client.list_sites()
    if json_output:
        print(json.dumps(result, indent=2))
        return
    table = Table(title="Quick sites")
    table.add_column("site_id")
    table.add_column("files", justify="right")
    table.add_column("url")
    for site in result["sites"]:
        table.add_row(site["site_id"], str(site["file_count"]), site["url"])
    console.print(table)


@app.command()
def get(
    site_id: str = typer.Argument(..., help="Site slug"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Show files and metadata for one deployed site."""
    client = get_client()
    result = client.get_site(site_id)
    if json_output:
        print(json.dumps(result, indent=2))
        return
    console.print(f"[bold]{result['site_id']}[/bold] -> {result['url']}")
    table = Table()
    table.add_column("path")
    table.add_column("content_type")
    table.add_column("bytes", justify="right")
    for f in result["files"]:
        table.add_row(f["path"], f["content_type"], str(f["bytes"]))
    console.print(table)


@app.command()
def delete(
    site_id: str = typer.Argument(..., help="Site slug"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Delete a deployed site and all of its files."""
    client = get_client()
    result = client.delete_site(site_id)
    if json_output:
        print(json.dumps(result, indent=2))
        return
    console.print(f"[red]Deleted[/red] {result['site_id']} ({result['deleted_files']} files)")


if __name__ == "__main__":
    app()
