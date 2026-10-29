"""指定したNPU実験領域のモデルデータを整理します。既定では計画のみ保存します。

直下のファイル、実験コード、説明文、テキスト、テンプレートを保持します。
再解析ポイントは拒否し、実行前に全対象を検証します。削除は通常ファイル単位です。
保存先と対象領域は利用者が指定し、実行時データの公開を避けてください。
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil


def metadata(path, root):
    # 絶対パスの範囲と全親のリンクを検査し、外部領域への逸脱を拒否します。
    path.relative_to(root)
    for current in (path, *path.parents):
        if getattr(current.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('再解析ポイントを含むため中止します。')
    info = path.stat()
    if not path.is_file():
        raise ValueError('通常ファイル以外は削除できません。')
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--report', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    root = Path(os.path.abspath(args.root))
    report = Path(os.path.abspath(args.report))
    if not root.is_dir() or root == Path(root.anchor) or report.is_relative_to(root):
        raise ValueError('対象領域と領域外の報告保存先を指定してください。')
    # 既存のコード・説明資料・入力例は内容ハッシュも採取して保持を検証します。
    keep_extensions = {'.py', '.ps1', '.md', '.txt', '.jinja', '.sh', '.bat', '.cmd', '.ipynb'}
    planned, kept = [], []
    for folder, dirs, files in os.walk(root, followlinks=False):
        for name in dirs:
            if getattr((Path(folder) / name).lstat(), 'st_file_attributes', 0) & 0x400:
                raise ValueError('対象内のリンクを検出したため中止します。')
        for name in files:
            path = Path(folder) / name
            stamp = metadata(path, root)
            if path.parent == root or path.suffix.lower() in keep_extensions:
                kept.append({'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
            else:
                planned.append({'path': str(path), 'metadata': stamp})
    result = {'root': str(root), 'startedAt': datetime.datetime.now().astimezone().isoformat(),
              'before': shutil.disk_usage(root)._asdict(), 'planned': planned,
              'kept': kept, 'deleted': [], 'errors': [], 'executed': args.execute}
    report.parent.mkdir(parents=True, exist_ok=True)

    def save():
        report.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')

    save()
    if args.execute:
        # 事前検証後も削除直前に再確認し、変更されたファイルは削除しません。
        for item in planned:
            metadata(Path(item['path']), root)
        for item in planned:
            path = Path(item['path'])
            try:
                if metadata(path, root) != item['metadata']:
                    raise ValueError('計画後の変更を検出しました。')
                path.unlink()
                result['deleted'].append(str(path))
            except (OSError, ValueError) as error:
                result['errors'].append({'path': str(path), 'error': str(error)})
        # 空になった配下のディレクトリだけを除去し、ルートは残します。
        for folder, dirs, files in os.walk(root, topdown=False):
            if Path(folder) != root:
                try:
                    Path(folder).rmdir()
                except OSError:
                    pass
    result['keptVerified'] = all(Path(item['path']).is_file() and
        hashlib.sha256(Path(item['path']).read_bytes()).hexdigest() == item['sha256'] for item in kept)
    result['after'] = shutil.disk_usage(root)._asdict()
    result['finishedAt'] = datetime.datetime.now().astimezone().isoformat()
    save()
    print('削除件数:', len(result['deleted']), '保持件数:', len(kept),
          '保持内容一致:', result['keptVerified'], 'エラー件数:', len(result['errors']))
    if result['errors'] or not result['keptVerified']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
