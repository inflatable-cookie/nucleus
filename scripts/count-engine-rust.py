#!/usr/bin/env python3
"""Compare the production Rust line count of committed engine trees."""

import argparse
from io import BytesIO
from pathlib import PurePosixPath
from posixpath import normpath
import re
import subprocess

from tree_sitter import Language, Parser, Query, QueryCursor
import tree_sitter_rust


COMMENTS = {"line_comment", "block_comment", "shebang"}
NON_PRODUCTION_PATH = re.compile(r"(?:^|_)(?:tests?|fixtures?|generated)$")
GENERATED_HEADER = re.compile(
    rb"(?im)^[ \t]*(?://+|/\*+|\*)[ \t]*(?:@generated\b|[^\r\n]*\bgenerated\b[^\r\n]*\bdo not edit\b)"
)
RUST = Language(tree_sitter_rust.language())
PARSER = Parser(RUST)
EXTERNAL_MODS = Query(RUST, "(mod_item !body) @module")


def string_content(node):
    return node.text.partition(b'"')[2].rpartition(b'"')[0]


def arguments(token_tree):
    """Split a cfg token tree at its own commas, leaving nested trees intact."""
    part = []
    for node in token_tree.children[1:-1]:
        if node.type == ",":
            yield part
            part = []
        elif node.type not in COMMENTS:
            part.append(node)
    if part:
        yield part


def cfg_value(tokens):
    """Evaluate test and fixture flags while leaving other flags unknown."""
    match tokens:
        case [name] if name.text in {b"test", b"doctest", b"false"}:
            return False
        case [name] if name.text == b"true":
            return True
        case [name, equals, value] if name.text == b"feature" and equals.type == "=":
            if string_content(value) == b"loopback-fixture":
                return False
        case [name, tree] if tree.type == "token_tree":
            values = [cfg_value(part) for part in arguments(tree)]
            if name.text == b"all":
                return False if False in values else None if None in values else True
            if name.text == b"any":
                return True if True in values else None if None in values else False
            if name.text == b"not" and len(values) == 1:
                return None if values[0] is None else not values[0]
    return None


def disables(tokens):
    if not tokens:
        return False
    name = tokens[0].text.rsplit(b"::", 1)[-1].strip()
    if name in {b"test", b"bench"}:
        return True
    if len(tokens) == 2 and tokens[1].type == "token_tree":
        parts = list(arguments(tokens[1]))
        if name == b"cfg" and len(parts) == 1:
            return cfg_value(parts[0]) is False
        if name == b"cfg_attr" and parts and cfg_value(parts[0]) is True:
            return any(disables(part) for part in parts[1:])
    return False


def attribute_tokens(node):
    attr = next(child for child in node.named_children if child.type == "attribute")
    return [child for child in attr.children if child.type not in COMMENTS]


def disabling_attribute(node):
    return disables(attribute_tokens(node))


def disabled_node(node, children):
    body = node.child_by_field_name("body")
    inner_scope = body.named_children if body is not None else children
    return any(
        disabling_attribute(child)
        for child in inner_scope
        if child.type == "inner_attribute_item"
    ) or (
        node.type == "match_arm"
        and any(
            disabling_attribute(child)
            for child in children
            if child.type == "attribute_item"
        )
    )


def ignored_ranges(node):
    children = node.named_children
    if node.type in COMMENTS or disabled_node(node, children):
        yield node.start_byte, node.end_byte
        return

    attributes = []
    for child in children:
        if child.type == "attribute_item" and node.type != "match_arm":
            attributes.append(child)
        elif child.type in COMMENTS:
            yield child.start_byte, child.end_byte
        elif any(disabling_attribute(attr) for attr in attributes):
            comma = child.next_sibling
            while comma is not None and comma.type in COMMENTS:
                comma = comma.next_sibling
            end = comma.end_byte if comma is not None and comma.type == "," else child.end_byte
            yield attributes[0].start_byte, end
            attributes.clear()
        else:
            for part in [*attributes, child]:
                yield from ignored_ranges(part)
            attributes.clear()


def module_name(node):
    return node.child_by_field_name("name").text.decode().removeprefix("r#")


def external_modules(root, path, ignored):
    """Find paths declared by external modules, including test-only modules."""
    for module in QueryCursor(EXTERNAL_MODS).captures(root).get("module", []):
        ancestors = []
        parent = module.parent
        while parent is not None:
            if parent.type == "mod_item":
                ancestors.append(module_name(parent))
            parent = parent.parent
        directory = path.parent
        if path.name not in {"lib.rs", "main.rs", "mod.rs"} and path.parts[4:-1] != ("bin",):
            directory /= path.stem
        directory = directory.joinpath(*reversed(ancestors))
        name = module_name(module)
        candidates = [directory / f"{name}.rs", directory / name / "mod.rs"]

        sibling = module.prev_named_sibling
        while sibling is not None and sibling.type in COMMENTS | {"attribute_item"}:
            if sibling.type == "attribute_item":
                tokens = attribute_tokens(sibling)
                if len(tokens) == 3 and tokens[0].text == b"path" and tokens[1].type == "=":
                    relative_to = directory if ancestors else path.parent
                    candidates = [relative_to / string_content(tokens[2]).decode()]
                    break
            sibling = sibling.prev_named_sibling

        enabled = not any(start <= module.start_byte < end for start, end in ignored)
        for candidate in candidates:
            yield PurePosixPath(normpath(candidate)), enabled


def source_measurement(source, path):
    root = PARSER.parse(source).root_node
    for child in root.named_children:
        if child.type not in COMMENTS:
            break
        if GENERATED_HEADER.search(child.text):
            return 0, []
    if root.has_error:
        raise ValueError(f"{path}: Rust parser could not parse source")
    remaining = bytearray(source)
    ignored = list(ignored_ranges(root))
    for start, end in ignored:
        remaining[start:end] = re.sub(rb"[^\n]+", lambda run: b" " * len(run[0]), source[start:end])
    count = sum(bool(line.strip()) for line in remaining.split(b"\n"))
    return count, list(external_modules(root, path, ignored))


def source_path(path):
    parts = path.parts
    return (
        len(parts) >= 5
        and parts[:2] == ("engine", "crates")
        and parts[3] == "src"
        and path.suffix == ".rs"
        and not any(NON_PRODUCTION_PATH.search(part) for part in (*parts[4:-1], path.stem))
    )


def git(*args, input=None):
    return subprocess.run(["git", *args], input=input, stdout=subprocess.PIPE, check=True).stdout


def count_commit(revision):
    commit = git("rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}").strip()
    tree = git("ls-tree", "-r", "-z", "--full-tree", commit, "--", "engine/crates")
    files = []
    for entry in tree.split(b"\0")[:-1]:
        info, raw_path = entry.split(b"\t", 1)
        mode, _, oid = info.split()
        path = PurePosixPath(raw_path.decode(errors="surrogateescape"))
        if mode in {b"100644", b"100755"} and source_path(path):
            files.append((oid, path))
    request = b"".join(oid + b"\n" for oid, _ in files)
    blobs = BytesIO(git("cat-file", "--batch", input=request))
    measures = {}
    for _, path in files:
        _, _, size = blobs.readline().split()
        measures[path] = source_measurement(blobs.read(int(size)), path)
        blobs.read(1)  # Git terminates each blob with a newline.

    # A file linked only through disabled modules is outside production, even
    # when the test or fixture uses an ordinary source filename.
    linked = {target for _, modules in measures.values() for target, _ in modules}
    reachable = set(measures) - linked
    pending = list(reachable)
    while pending:
        _, modules = measures[pending.pop()]
        for target, enabled in modules:
            if enabled and target in measures and target not in reachable:
                reachable.add(target)
                pending.append(target)
    return commit.decode(), sum(measures[path][0] for path in reachable)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ceiling", type=int, metavar="LINES")
    parser.add_argument("revisions", nargs="*", metavar="COMMIT", default=["HEAD"])
    args = parser.parse_args()
    revisions = args.revisions
    try:
        counts = [count_commit(revision) for revision in revisions]
    except (subprocess.CalledProcessError, ValueError) as error:
        parser.exit(1, f"{error}\n")
    for index, (revision, (commit, count)) in enumerate(zip(revisions, counts)):
        delta = "" if index == 0 else f"  ({count - counts[0][1]:+,} vs {revisions[0]})"
        budget = ""
        if args.ceiling is not None:
            ceiling = args.ceiling
            budget = f" / {ceiling:,} ({ceiling - count:+,} remaining)"
        print(f"{revision} {commit[:12]}  {count:,}{budget}{delta}")
    if args.ceiling is not None and any(count > args.ceiling for _, count in counts):
        parser.exit(1, f"production line count exceeds the {args.ceiling:,}-line ceiling\n")


if __name__ == "__main__":
    main()
