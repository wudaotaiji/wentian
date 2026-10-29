/** モデル多様性（Model Diversity）はエージェント名ではなく、実行モデルの登録IDで評価します。 */
export function independentVerifier(builderModel: string | undefined, verifierModel: string | undefined, families: Record<string, string> = {}): boolean {
  const unknown = /(?:^|[/-])auto(?:[/-]|$)|:free$|\/free$/i;
  if (!builderModel || !verifierModel || unknown.test(builderModel) || unknown.test(verifierModel)) return false;
  const builder = families[builderModel] ?? builderModel.toLowerCase();
  const verifier = families[verifierModel] ?? verifierModel.toLowerCase();
  return builder !== verifier;
}
