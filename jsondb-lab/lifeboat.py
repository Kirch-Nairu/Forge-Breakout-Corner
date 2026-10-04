#!/usr/bin/env python3
"""JSONDB cross-runtime lifeboat.

Python 3 standard library only. No imports from JSONDB.
It intentionally reimplements a subset of recovery logic so Node/JavaScript is not
our only rescue runtime.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: Any) -> Any:
    if isinstance(value, list):
        items = [canonical(x) for x in value]
        if items and all(isinstance(x, dict) and isinstance(x.get("id"), str) for x in items):
            items.sort(key=lambda x: x["id"])
        return items
    if isinstance(value, dict):
        return {k: canonical(value[k]) for k in sorted(value)}
    return value


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(canonical(value), ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def semantic_hash(value: Any) -> str:
    return sha256(canonical_bytes(value))


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def read_jsonl(path: Path) -> List[Any]:
    out = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                out.append(json.loads(line))
    return out


def merkle_root(hashes: List[str]) -> str:
    if not hashes:
        return sha256(b"[]")
    layer = list(hashes)
    while len(layer) > 1:
        nxt = []
        for i in range(0, len(layer), 2):
            left = layer[i]
            right = layer[i + 1] if i + 1 < len(layer) else left
            nxt.append(sha256(f"{left}:{right}".encode()))
        layer = nxt
    return layer[0]


def verify_seed(seed_dir: Path) -> Dict[str, Any]:
    manifest = read_json(seed_dir / "SEED-MANIFEST.json")
    results = []
    for entry in manifest.get("entries", []):
        path = seed_dir / entry["path"]
        try:
            actual = sha256(path.read_bytes())
            results.append({"path": entry["path"], "valid": actual == entry["sha256"], "actual": actual, "expected": entry["sha256"]})
        except Exception as exc:
            results.append({"path": entry["path"], "valid": False, "error": str(exc)})
    computed_root = merkle_root([x["sha256"] for x in manifest.get("entries", [])])
    valid = all(x.get("valid") for x in results) and computed_root == manifest.get("merkleRoot")
    return {"format": "JSONDB-PY-SEED-VERIFY-1", "valid": valid, "expectedMerkleRoot": manifest.get("merkleRoot"), "computedMerkleRoot": computed_root, "results": results}


def memory_paths(savior_root: Path, manifest_id: Optional[str]) -> Tuple[Path, Dict[str, Any]]:
    root = savior_root / "memory-palace"
    manifest_path = root / "manifests" / f"{manifest_id}.json" if manifest_id else root / "latest.json"
    return root, read_json(manifest_path)


def memory_read_chunk(root: Path, hash_value: str) -> Tuple[Optional[bytes], Optional[str]]:
    relative = Path(hash_value[:2]) / f"{hash_value}.json"
    candidates = [("primary", root / "objects" / relative)]
    vaults = root / "vaults"
    if vaults.exists():
        for child in sorted(vaults.iterdir()):
            if child.is_dir():
                candidates.append((child.name, child / relative))
    for source, path in candidates:
        try:
            doc = read_json(path)
            data = base64.b64decode(doc["base64"])
            if sha256(data) == hash_value == doc.get("sha256"):
                return data, source
        except Exception:
            pass
    return None, None


def verify_memory(savior_root: Path, manifest_id: Optional[str] = None) -> Dict[str, Any]:
    root, manifest = memory_paths(savior_root, manifest_id)
    chunks = []
    buffers = []
    for spec in manifest.get("chunks", []):
        data, source = memory_read_chunk(root, spec["hash"])
        chunks.append({"hash": spec["hash"], "recovered": data is not None, "source": source})
        if data is not None:
            buffers.append(data)
    complete = len(buffers) == len(manifest.get("chunks", []))
    world = b"".join(buffers)[: manifest.get("worldBytes", 0)] if complete else None
    actual = sha256(world) if world is not None else None
    root_hash = merkle_root([x["hash"] for x in manifest.get("chunks", [])])
    valid = bool(complete and actual == manifest.get("worldSha256") and root_hash == manifest.get("chunkMerkleRoot"))
    return {"format": "JSONDB-PY-MEMORY-VERIFY-1", "valid": valid, "status": "TRUSTED" if valid else "INCOMPLETE_OR_MISMATCH", "manifest": manifest, "chunks": chunks, "actualWorldSha256": actual, "computedMerkleRoot": root_hash, "_buffer": world}


def restore_memory(savior_root: Path, output: Path, manifest_id: Optional[str] = None) -> Dict[str, Any]:
    result = verify_memory(savior_root, manifest_id)
    if not result["valid"] or result["_buffer"] is None:
        raise RuntimeError("Memory Palace verification failed")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(result["_buffer"])
    return {"restored": str(output), "sha256": result["actualWorldSha256"], "chunks": len(result["chunks"])}


def format_generation(savior_root: Path, generation: Optional[str]) -> Tuple[Path, Dict[str, Any]]:
    root = savior_root / "format-polyglot"
    manifest = read_json(root / "generations" / generation / "manifest.json") if generation else read_json(root / "latest.json")
    return root / "generations" / manifest["id"], manifest


def decode_format_worlds(directory: Path) -> List[Tuple[str, Any, Optional[str]]]:
    results: List[Tuple[str, Any, Optional[str]]] = []
    try:
        results.append(("direct-json", read_json(directory / "direct.json")["world"], None))
    except Exception as exc:
        results.append(("direct-json", None, str(exc)))
    try:
        doc = read_json(directory / "base64.json")
        results.append(("base64-json", json.loads(base64.b64decode(doc["base64"]).decode("utf-8")), None))
    except Exception as exc:
        results.append(("base64-json", None, str(exc)))
    try:
        doc = read_json(directory / "hex.json")
        results.append(("hex-json", json.loads(bytes.fromhex("".join(doc["chunks"])).decode("utf-8")), None))
    except Exception as exc:
        results.append(("hex-json", None, str(exc)))
    try:
        records = read_jsonl(directory / "records.jsonl")
        header = next(x for x in records if x.get("type") == "header")
        world = {"format": header["format"], "catalog": header["catalog"], "meta": header["meta"], "tables": {}}
        for record in records:
            if record.get("type") == "table-meta":
                world["tables"][record["collection"]] = {"name": record.get("name", record["collection"]), "meta": record.get("meta", {}), "rows": []}
            elif record.get("type") == "row":
                world["tables"].setdefault(record["collection"], {"name": record["collection"], "meta": {}, "rows": []})["rows"].append(record["row"])
        results.append(("record-jsonl", world, None))
    except Exception as exc:
        results.append(("record-jsonl", None, str(exc)))
    return results


def verify_format(savior_root: Path, generation: Optional[str] = None) -> Dict[str, Any]:
    directory, manifest = format_generation(savior_root, generation)
    decoded = []
    votes: Dict[str, int] = {}
    worlds: Dict[str, Any] = {}
    for name, world, error in decode_format_worlds(directory):
        if error:
            decoded.append({"name": name, "ok": False, "error": error})
            continue
        hv = semantic_hash(world)
        votes[hv] = votes.get(hv, 0) + 1
        worlds[name] = world
        decoded.append({"name": name, "ok": True, "hash": hv, "matchesExpected": hv == manifest["expectedSemanticHash"]})
    winner = sorted(votes.items(), key=lambda x: (-x[1], x[0]))[0] if votes else None
    trusted = bool(winner and winner[1] >= manifest.get("quorum", 3) and winner[0] == manifest["expectedSemanticHash"])
    return {"format": "JSONDB-PY-FORMAT-VERIFY-1", "trusted": trusted, "status": "TRUSTED" if trusted else "DEGRADED_OR_LOST", "manifest": manifest, "winner": {"hash": winner[0], "votes": winner[1]} if winner else None, "decoders": decoded, "_worlds": worlds}


def restore_format(savior_root: Path, output: Path, generation: Optional[str] = None) -> Dict[str, Any]:
    result = verify_format(savior_root, generation)
    if not result["trusted"]:
        raise RuntimeError("Format Polyglot quorum not trusted")
    expected = result["manifest"]["expectedSemanticHash"]
    world = next(world for world in result["_worlds"].values() if semantic_hash(world) == expected)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(canonical(world), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"restored": str(output), "semanticHash": expected}


def xor_into(target: bytearray, source: bytes) -> None:
    for i, b in enumerate(source):
        target[i] ^= b


def read_fountain_packets(directory: Path) -> List[Dict[str, Any]]:
    packets = []
    for path in sorted(directory.glob("droplet-*.json")):
        try:
            doc = read_json(path)
            data = base64.b64decode(doc["base64"])
            if sha256(data) != doc.get("payloadSha256"):
                continue
            doc["_bytes"] = data
            doc["_file"] = path.name
            packets.append(doc)
        except Exception:
            pass
    return packets


def fountain_group_key(packet: Dict[str, Any]) -> Tuple[Any, ...]:
    return (packet.get("generation"), packet.get("originalSha256"), packet.get("sourceChunks"), packet.get("chunkSize"), packet.get("originalBytes"))


def peel_fountain(group: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not group:
        return {"complete": False, "solved": 0}
    k = int(group[0]["sourceChunks"])
    equations = [{"indexes": set(p["indexes"]), "bytes": bytearray(p["_bytes"])} for p in group]
    solved: Dict[int, bytes] = {}
    progress = True
    while progress:
        progress = False
        for eq in equations:
            for idx, data in list(solved.items()):
                if idx in eq["indexes"]:
                    eq["indexes"].remove(idx)
                    xor_into(eq["bytes"], data)
            if len(eq["indexes"]) == 1:
                idx = next(iter(eq["indexes"]))
                if idx not in solved:
                    solved[idx] = bytes(eq["bytes"])
                    progress = True
    missing = [i for i in range(k) if i not in solved]
    if missing:
        return {"complete": False, "solved": len(solved), "sourceChunks": k, "missing": missing}
    data = b"".join(solved[i] for i in range(k))[: int(group[0]["originalBytes"])]
    actual = sha256(data)
    return {"complete": actual == group[0]["originalSha256"], "solved": k, "sourceChunks": k, "expectedSha256": group[0]["originalSha256"], "actualSha256": actual, "_buffer": data}


def recover_fountain(directory: Path) -> Dict[str, Any]:
    packets = read_fountain_packets(directory)
    groups: Dict[Tuple[Any, ...], List[Dict[str, Any]]] = {}
    for p in packets:
        groups.setdefault(fountain_group_key(p), []).append(p)
    attempts = []
    for group in sorted(groups.values(), key=len, reverse=True):
        result = peel_fountain(group)
        attempts.append({k: v for k, v in result.items() if k != "_buffer"} | {"generation": group[0]["generation"], "packets": len(group)})
        if result.get("complete"):
            return {"status": "RECOVERED", "packetsRead": len(packets), "winner": attempts[-1], "attempts": attempts, "_buffer": result["_buffer"]}
    return {"status": "INCOMPLETE", "packetsRead": len(packets), "attempts": attempts, "_buffer": None}


def restore_fountain(directory: Path, output: Path) -> Dict[str, Any]:
    result = recover_fountain(directory)
    if result["status"] != "RECOVERED" or result["_buffer"] is None:
        raise RuntimeError("Not enough fountain equations survived")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(result["_buffer"])
    return {"restored": str(output), "sha256": result["winner"]["actualSha256"], "packetsRead": result["packetsRead"]}


def clean(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items() if not k.startswith("_")}
    if isinstance(obj, list):
        return [clean(v) for v in obj]
    return obj


def main() -> None:
    parser = argparse.ArgumentParser(description="JSONDB Python stdlib lifeboat")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("seed-verify"); p.add_argument("directory", type=Path)
    p = sub.add_parser("memory-verify"); p.add_argument("savior_root", type=Path); p.add_argument("id", nargs="?")
    p = sub.add_parser("memory-restore"); p.add_argument("savior_root", type=Path); p.add_argument("output", type=Path); p.add_argument("id", nargs="?")
    p = sub.add_parser("format-verify"); p.add_argument("savior_root", type=Path); p.add_argument("id", nargs="?")
    p = sub.add_parser("format-restore"); p.add_argument("savior_root", type=Path); p.add_argument("output", type=Path); p.add_argument("id", nargs="?")
    p = sub.add_parser("fountain-verify"); p.add_argument("directory", type=Path)
    p = sub.add_parser("fountain-restore"); p.add_argument("directory", type=Path); p.add_argument("output", type=Path)

    args = parser.parse_args()
    if args.command == "seed-verify": result = verify_seed(args.directory)
    elif args.command == "memory-verify": result = verify_memory(args.savior_root, args.id)
    elif args.command == "memory-restore": result = restore_memory(args.savior_root, args.output, args.id)
    elif args.command == "format-verify": result = verify_format(args.savior_root, args.id)
    elif args.command == "format-restore": result = restore_format(args.savior_root, args.output, args.id)
    elif args.command == "fountain-verify": result = recover_fountain(args.directory)
    elif args.command == "fountain-restore": result = restore_fountain(args.directory, args.output)
    else: raise RuntimeError("unknown command")
    print(json.dumps(clean(result), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
