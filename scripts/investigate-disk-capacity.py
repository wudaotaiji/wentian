"""ディスク容量の読み取り専用調査。内容を開かずサイズ・日時だけを集計します。

指定フォルダーを直列に走査し、リンクを辿らず、一定件数ごとに休止します。
Windowsでは調査プロセスを低い優先度にします。削除・移動は行いません。
論理サイズの集計はハードリンクの重複を含むため、使用済み実容量とは区別します。
大きなファイルはWindowsの割当サイズも取得し、疎な仮想ディスクと区別します。
保存先は必須引数で指定し、個人パスを含む生データの公開を避けてください。
"""
import argparse
import collections
import ctypes
import datetime
import heapq
import json
import os
import pathlib
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', action='append', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if os.name == 'nt':
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x40)
    totals, created_days, modified_days = collections.Counter(), collections.Counter(), collections.Counter()
    largest, errors, links, count = [], [], 0, 0
    started = datetime.datetime.now().astimezone().isoformat()

    def timestamp(value):
        return datetime.datetime.fromtimestamp(value).astimezone().isoformat(timespec='seconds')

    def allocated(filename):
        if os.name != 'nt':
            return None
        # ファイル本文を読まず、NTFSが返す割当バイト数だけを取得します。
        api = ctypes.windll.kernel32.GetCompressedFileSizeW
        api.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
        api.restype = ctypes.c_ulong
        high = ctypes.c_ulong()
        ctypes.windll.kernel32.SetLastError(0)
        low = api(filename, ctypes.byref(high))
        if low == 0xffffffff and ctypes.windll.kernel32.GetLastError():
            return None
        return (high.value << 32) | low

    for supplied in args.root:
        root = pathlib.Path(supplied).resolve()
        pending, size, files = [str(root)], 0, 0
        while pending:
            folder = pending.pop()
            try:
                with os.scandir(folder) as entries:
                    for entry in entries:
                        try:
                            info = entry.stat(follow_symlinks=False)
                            if getattr(info, 'st_file_attributes', 0) & 0x400:
                                links += 1
                                continue
                            if entry.is_dir(follow_symlinks=False):
                                pending.append(entry.path)
                                continue
                            if not entry.is_file(follow_symlinks=False):
                                continue
                            amount = info.st_size
                            size += amount
                            files += 1
                            count += 1
                            relative = pathlib.Path(entry.path).relative_to(root).parts
                            totals[str(root)] += amount
                            # 最大5階層の集計で、ユーザー領域とキャッシュの内訳を残します。
                            for depth in range(1, min(5, len(relative) - 1) + 1):
                                totals[str(root.joinpath(*relative[:depth]))] += amount
                            created = timestamp(getattr(info, 'st_birthtime', info.st_ctime))
                            modified = timestamp(info.st_mtime)
                            if amount >= 100 * 1024 ** 2:
                                created_days[created[:10]] += amount
                                modified_days[modified[:10]] += amount
                            item = (amount, entry.path, created, modified)
                            if len(largest) < 80:
                                heapq.heappush(largest, item)
                            elif item > largest[0]:
                                heapq.heapreplace(largest, item)
                            if count % 2000 == 0:
                                time.sleep(0.05)
                        except (OSError, ValueError) as error:
                            if len(errors) < 100:
                                errors.append({'path': entry.path, 'type': type(error).__name__})
            except OSError as error:
                if len(errors) < 100:
                    errors.append({'path': folder, 'type': type(error).__name__})
        print(json.dumps({'root': str(root), 'logicalGiB': round(size / 1024 ** 3, 3), 'files': files}, ensure_ascii=False), flush=True)
    result = {'startedAt': started, 'finishedAt': datetime.datetime.now().astimezone().isoformat(),
        'files': count, 'skippedReparsePoints': links, 'errors': errors,
        'totals': dict(totals.most_common()), 'largeFilesCreatedDays': dict(created_days.most_common()),
        'largeFilesModifiedDays': dict(modified_days.most_common()),
        'largestFiles': [{'bytes': amount, 'allocatedBytes': allocated(filename), 'path': filename,
            'createdAt': created, 'modifiedAt': modified} for amount, filename, created, modified in sorted(largest, reverse=True)]}
    destination = pathlib.Path(args.output).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print('容量調査の集計を保存しました。', flush=True)


if __name__ == '__main__':
    main()
