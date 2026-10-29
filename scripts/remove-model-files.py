"""明示されたGGUFファイルだけを削除します。実行指定なしでは計画のみ保存します。

対象ルート・ファイル・報告先は利用者が指定します。再解析ポイントと範囲外を拒否し、
全対象の事前検査後、削除直前にもサイズ・ファイルID・変更時刻を再検査します。
使用状況の判断は行いません。呼出し側で使用中・選択中のモデルを除外してください。
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil


def inspect(path, root):
    # ルート外や親リンク経由の削除を防ぎ、通常のGGUFだけに限定します。
    path.relative_to(root)
    for item in (path, *path.parents):
        if getattr(item.lstat(), 'st_file_attributes', 0) & 0x400 or item.is_symlink():
            raise ValueError('リンクを経由する対象は削除できません。')
    if not path.is_file() or path.suffix.lower() != '.gguf':
        raise ValueError('通常のGGUFファイルを指定してください。')
    info = path.stat()
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--file', action='append', required=True)
    parser.add_argument('--report', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    root = Path(os.path.abspath(args.root))
    report = Path(os.path.abspath(args.report))
    if root == Path(root.anchor) or report.is_relative_to(root):
        raise ValueError('ルート範囲と領域外の報告先を指定してください。')
    paths = list(dict.fromkeys(Path(os.path.abspath(item)) for item in args.file))
    planned = [{'path': str(path), 'metadata': inspect(path, root)} for path in paths]
    result = {'startedAt': datetime.datetime.now().astimezone().isoformat(),
              'root': str(root), 'before': shutil.disk_usage(root)._asdict(),
              'planned': planned, 'deleted': [], 'errors': [], 'executed': args.execute}
    report.parent.mkdir(parents=True, exist_ok=True)

    def save():
        report.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')

    save()
    if args.execute:
        for item in planned:
            path = Path(item['path'])
            try:
                if inspect(path, root) != item['metadata']:
                    raise ValueError('計画後にファイルが変更されたため保持します。')
                path.unlink()
                result['deleted'].append(str(path))
            except (OSError, ValueError) as error:
                result['errors'].append({'path': str(path), 'error': str(error)})
                save()
                raise
    result['after'] = shutil.disk_usage(root)._asdict()
    result['finishedAt'] = datetime.datetime.now().astimezone().isoformat()
    save()
    print('計画件数:', len(planned), '削除件数:', len(result['deleted']))


if __name__ == '__main__':
    main()
