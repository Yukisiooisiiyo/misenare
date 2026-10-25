// 行レベルセキュリティが本当に効く接続かを確かめる。
// スーパーユーザーと BYPASSRLS 権限を持つロールは、FORCE ROW LEVEL SECURITY でも RLS を素通りする。
// その接続でサーバーを動かすと、会社をまたいでデータが見えてしまうので起動を止める。

export async function assertRlsEnforced(raw: (sql: string) => Promise<unknown[]>): Promise<void> {
  const rows = (await raw(
    `SELECT current_user AS name, rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
  )) as Array<{ name: string; superuser: boolean; bypass: boolean }>;
  const role = rows[0];
  if (!role) throw new Error('接続ロールを確認できませんでした');
  if (role.superuser || role.bypass) {
    throw new Error(
      `接続ロール "${role.name}" はスーパーユーザーか BYPASSRLS を持っているため、行レベルセキュリティが効きません。` +
        'NOSUPERUSER NOBYPASSRLS の一般ロールで接続してください。',
    );
  }
}
