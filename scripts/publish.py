#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
codex-status 一键打包并发布到 GitHub Release

流程:
1. 读 package.json 的 version,patch 段 +1 并写回(可选,见 --no-bump)
2. 用国内镜像跑 npm run build:win
3. 校验 dist/ 下 setup.exe / latest.yml / .blockmap 三个产物都在
4. 用 gh release create 发布到 GitHub,自动传三件套

前置:
- gh CLI 已装并 gh auth login 登录(有 repo 权限)
- 仓库 owner/repo 已在下方 OWNER_REPO 写死

用法:
    python scripts/publish.py            # 升版本号 + 打包 + 发布
    python scripts/publish.py --no-bump  # 不升版本号,用当前 version 打包发布
    python scripts/publish.py --dry-run  # 只打包不发布,检查产物
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# Windows 控制台默认 GBK,中文/符号会崩;强制 stdout/stderr 用 utf-8
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass

# ---- 配置 ----
# GitHub 仓库全名(owner/repo)。git 未配 remote,这里写死。
OWNER_REPO = "libing93920/CodexStatus"
# gh.exe 兜底路径:winget 装在这。若 PATH 里找不到 gh 就用它。
GH_FALLBACK = r"C:\Program Files\GitHub CLI\gh.exe"
# 镜像环境变量:避免 electron-builder 连 GitHub 校验超时
MIRROR_ENV = {
    "ELECTRON_MIRROR": "https://npmmirror.com/mirrors/electron/",
    "ELECTRON_BUILDER_BINARIES_MIRROR": "https://npmmirror.com/mirrors/electron-builder-binaries/",
}
# 产物所在目录(相对仓库根)
DIST = "dist"
# 三个必传产物:setup.exe / latest.yml / .blockmap
ARTIFACT_GLOBS = {
    "setup": "CodexStatus-{ver}-setup.exe",
    "latest": "latest.yml",
    "blockmap": "CodexStatus-{ver}-setup.exe.blockmap",
}


def repo_root() -> Path:
    # 脚本在 scripts/ 下,根目录是上一层
    return Path(__file__).resolve().parent.parent


def run(cmd: list[str], env: dict | None = None, check: bool = True) -> subprocess.CompletedProcess:
    """跑命令,实时输出到终端;check=True 时非 0 退出码抛错。

    Windows 下 npm/gh 是 .cmd/.exe,需要 shell=True 让 shell 解析扩展名。
    """
    print(f"\n$ {' '.join(cmd)}")
    result = subprocess.run(cmd, env=env, shell=os.name == "nt")
    if check and result.returncode != 0:
        raise SystemExit(f"命令失败(退出码 {result.returncode}): {' '.join(cmd)}")
    return result


def find_gh() -> str:
    """找 gh 可执行文件:先 PATH,再兜底路径"""
    gh = shutil.which("gh")
    if gh:
        return gh
    if Path(GH_FALLBACK).exists():
        return GH_FALLBACK
    raise SystemExit(
        "找不到 gh CLI。装它:winget install --id GitHub.cli,然后 gh auth login 登录。"
    )


def gh_authed(gh: str) -> bool:
    """检查 gh 是否已认证(用 utf-8 解码,避免 GBK 终端解码 gh 中文输出崩)"""
    result = subprocess.run(
        [gh, "auth", "status"], capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    return result.returncode == 0


def read_version(root: Path) -> str:
    pkg = json.loads((root / "package.json").read_text(encoding="utf-8"))
    return pkg["version"]


def bump_version(root: Path) -> tuple[str, str]:
    """patch 段 +1,写回 package.json;返回 (旧版本, 新版本)"""
    path = root / "package.json"
    pkg = json.loads(path.read_text(encoding="utf-8"))
    old = pkg["version"]
    parts = old.split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        raise SystemExit(f"version 不是标准 x.y.z 格式: {old}")
    parts[2] = str(int(parts[2]) + 1)
    new = ".".join(parts)
    pkg["version"] = new
    path.write_text(json.dumps(pkg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"版本号: {old} -> {new}")
    return old, new


def build(env: dict) -> None:
    """跑镜像打包命令"""
    full_env = {**os.environ, **env}
    run(["npm", "run", "build:win"], env=full_env)


def verify_artifacts(root: Path, version: str) -> dict[str, Path]:
    """检查三个产物都在;返回路径字典"""
    dist = root / DIST
    found: dict[str, Path] = {}
    missing: list[str] = []
    for key, pattern in ARTIFACT_GLOBS.items():
        name = pattern.format(ver=version)
        path = dist / name
        if path.exists():
            found[key] = path
            print(f"  [OK] {name} ({path.stat().st_size // 1024} KB)")
        else:
            missing.append(name)
    if missing:
        raise SystemExit(f"产物缺失: {', '.join(missing)}")
    return found


def release_exists(gh: str, tag: str) -> bool:
    """检查 GitHub 上是否已有同名 Release/tag"""
    result = subprocess.run(
        [gh, "release", "view", tag, "-R", OWNER_REPO],
        capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    return result.returncode == 0


def publish(gh: str, version: str, artifacts: dict[str, Path], notes: str | None) -> None:
    """gh release create 发布三件套"""
    tag = f"v{version}"
    if release_exists(gh, tag):
        raise SystemExit(
            f"Release {tag} 已存在。先在网页删掉旧 Release,或改 package.json 版本号重打。"
        )
    cmd = [
        gh, "release", "create", tag,
        "-R", OWNER_REPO,
        "--title", tag,
        str(artifacts["setup"]),
        str(artifacts["latest"]),
        str(artifacts["blockmap"]),
    ]
    if notes:
        # 写临时文件避免 shell 转义截断多行 notes
        notes_path = repo_root() / "dist" / "release-notes.md"
        notes_path.write_text(notes, encoding="utf-8")
        cmd += ["--notes-file", str(notes_path)]
    else:
        cmd += ["--notes", f"CodexStatus {tag}"]
    run(cmd)
    print(f"\n[已发布] https://github.com/{OWNER_REPO}/releases/tag/{tag}")


def main() -> None:
    parser = argparse.ArgumentParser(description="打包并发布 codex-status 到 GitHub Release")
    parser.add_argument("--no-bump", action="store_true", help="不升版本号,用当前 version 打包")
    parser.add_argument("--dry-run", action="store_true", help="只打包不发布")
    parser.add_argument("--notes", help="Release 说明文本(不给则 --generate-notes)")
    args = parser.parse_args()

    root = repo_root()
    os.chdir(root)

    # 1. 版本号
    if not args.no_bump:
        bump_version(root)
    version = read_version(root)
    print(f"打包版本: v{version}")

    # 2. 检查 gh 认证(dry-run 不发版可跳过)
    if not args.dry_run:
        gh = find_gh()
        if not gh_authed(gh):
            raise SystemExit("gh 未登录。先跑: gh auth login")

    # 3. 打包
    print("\n=== 打包(npm run build:win,镜像加速)===")
    build(MIRROR_ENV)

    # 4. 校验产物
    print("\n=== 校验产物 dist/ ===")
    artifacts = verify_artifacts(root, version)

    if args.dry_run:
        print("\n--dry-run: 跳过发布。产物已就绪:")
        for path in artifacts.values():
            print(f"  {path}")
        return

    # 5. 发布
    print("\n=== 发布到 GitHub Release ===")
    publish(gh, version, artifacts, args.notes)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n中断")
        sys.exit(130)
    except SystemExit as e:
        # argparse --help 会抛 SystemExit(0),正常透传;非 0 才当错误打印
        if e.code and str(e.code) != "0":
            print(f"\n失败: {e}")
        sys.exit(e.code if isinstance(e.code, int) else 1)
