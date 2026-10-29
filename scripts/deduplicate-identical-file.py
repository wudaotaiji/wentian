"""同一内容のファイルをNTFSハードリンクへまとめ、両方のパスを維持します。

両方のSHA-256を低速で全件照合し、比較中の変更を拒否します。
同一ボリューム・通常ファイルに限定し、リンク・再解析ポイントは拒否します。
実行時は元ファイルを同じ場所へ退避してからリンクを作り、検証後だけ退避を削除します。
作成・検証の失敗時は元へ戻します。--executeがない場合は照合のみです。
"""
import argparse
import hashlib
import json
import os
import pathlib
import stat
import time
import uuid


def fingerprint(path):
    data = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(data.st_mode) or getattr(data, 'st_file_attributes', 0) & 0x400:
        raise ValueError('リンク以外の通常ファイルを指定してください。')
    # 親のリンクを経由して想定外の領域を書き換えないよう確認します。
    for parent in path.parents:
        if getattr(parent.stat(follow_symlinks=False), 'st_file_attributes', 0) & 0x400:
            raise ValueError('親フォルダーに再解析ポイントがあります。')
    return (data.st_dev, data.st_ino, data.st_size, data.st_mtime_ns)


def digest(path, rate):
    before = fingerprint(path)
    result = hashlib.sha256()
    began, amount = time.monotonic(), 0
    with path.open('rb') as stream:
        while block := stream.read(1024 * 1024):
            result.update(block)
            amount += len(block)
            # 大きなモデルを一気に読み込まず、明示した上限速度でディスク負荷を抑えます。
            delay = amount / rate - (time.monotonic() - began)
            if delay > 0:
                time.sleep(delay)
    if fingerprint(path) != before:
        raise RuntimeError('照合中にファイルが変更されました。')
    return result.hexdigest(), before


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--duplicate', required=True)
    parser.add_argument('--report', required=True)
    parser.add_argument('--read-mib-per-second', type=int, default=64)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.read_mib_per_second <= 64:
        parser.error('読込み上限は1～64 MiB/秒で指定してください。')
    source, duplicate = (pathlib.Path(os.path.abspath(p)) for p in (args.source, args.duplicate))
    first, second = fingerprint(source), fingerprint(duplicate)
    if first[0] != second[0] or first[2] != second[2]:
        raise ValueError('同じボリューム・同じサイズのファイルが必要です。')
    if os.path.samefile(source, duplicate):
        raise ValueError('既に同じファイルを共有しています。')
    rate = args.read_mib_per_second * 1024**2
    sha_source, first = digest(source, rate)
    sha_duplicate, second = digest(duplicate, rate)
    if sha_source != sha_duplicate:
        raise ValueError('内容が異なるため変更しません。')
    result = {'source':str(source),'duplicate':str(duplicate),'sha256':sha_source,
        'bytes':first[2],'identical':True,'applied':False}
    if args.execute:
        if fingerprint(source) != first or fingerprint(duplicate) != second:
            raise RuntimeError('照合後にファイルが変更されました。')
        backup = duplicate.with_name(duplicate.name + '.' + uuid.uuid4().hex + '.dedup-backup')
        duplicate.rename(backup)
        try:
            os.link(source, duplicate)
            if not os.path.samefile(source, duplicate) or duplicate.stat().st_size != first[2]:
                raise RuntimeError('ハードリンクの検証に失敗しました。')
            # 削除するのは指定した重複の退避1ファイルだけです。フォルダーは削除しません。
            backup.unlink()
        except BaseException:
            if duplicate.exists():
                duplicate.unlink()
            backup.rename(duplicate)
            raise
        result['applied'] = True
        result['links'] = source.stat().st_nlink
    destination = pathlib.Path(args.report)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))


if __name__ == '__main__':
    main()
