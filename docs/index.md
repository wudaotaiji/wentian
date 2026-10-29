# Wentian 公開ドキュメント

公開コードの導入・利用・拡張に必要な資料をまとめています。内部の設計草案、事業戦略、実環境の調査・検証原票は別の私有文書リポジトリで管理します。公開資料だけで基本的な導入と開発を進められる構成を維持します。

## はじめに

- [Windowsオンライン導入と初期設定](windows_installation.md)

- [導入手順](INSTALLATION_GUIDE.md)・[ローカル取得](LOCAL_INSTALL_GUIDE_JA.md)
- [利用ガイド](USER_GUIDE.md)・[CLIリファレンス](CLI_REFERENCE.md)
- [ローカルLLM設定](LOCAL_LLM_CONFIGURATION.md)
- [公開機能と制限](feature_scope.md)

## 機能ガイド

- [エージェント管理](AGENT_MANAGEMENT.md)・[会話グループ](AGENT_GROUPS.md)
- [タスク予約](TASK_SCHEDULER.md)・[ユーザーとアカウント](user_management.md)
- [プロジェクト知識庫](project_knowledge_agent.md)・[確認用サンプル](knowledge_feature_walkthrough.md)
- [会議・遠隔支援](meetings_remote_assistance.md)・[録画と議事録](meeting_recordings.md)
- [Personal Cloud](personal_cloud_implementation.md)・[ノード連合](decentralized_cloud_implementation.md)
- [ウォレット](wallet_integration.md)
- [音声・動画](media_production.md)・[画像素材](visual_assets.md)
- [サイト制作](site_creation.md)・[サイトの保存と出力](site_source_export.md)

## 開発と公開

- [全体アーキテクチャー](ARCHITECTURE.md)
- [Pluginアーキテクチャー](PLUGIN_ARCHITECTURE.md)
- [MCPクライアント](MCP_CLIENT_USAGE.md)・[MCPサーバー仕様](MCP_IMPLEMENTATION_SPEC.md)
- [表示言語の拡張](common_ui_localization.md)
- [公開準備](OPEN_SOURCE_RELEASE.md)

公開文書はルートの`public_release_documents.json`に完全一致で登録します。未登録の文書・添付ファイルは公開候補へ含めません。資料を追加する場合は内容・リンク・公開範囲を確認してからリストを更新してください。
