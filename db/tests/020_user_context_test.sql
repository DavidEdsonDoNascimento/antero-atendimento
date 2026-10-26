-- Antero Atendimentos — Entrega 2: contexto do usuário (app.current_user_id).
--
-- Diferente dos outros arquivos, este NÃO roda dentro de um único
-- BEGIN...ROLLBACK: o objetivo é justamente provar o comportamento ENTRE
-- transações da mesma conexão (como numa conexão reaproveitada pelo pool).
-- Não grava dados em tabela nenhuma; só manipula configurações da sessão.
\set QUIET 1
SELECT gen_random_uuid() AS user_a, gen_random_uuid() AS user_b \gset

SELECT plan(19);

-- ---------------------------------------------------------------------------
-- Propriedades e privilégios das funções de contexto
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT bool_or(p.prosecdef) FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace),
  false,
  'funções de contexto NÃO são SECURITY DEFINER'
);
SELECT ok(
  (SELECT bool_and(p.proconfig @> ARRAY['search_path=""']) FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace),
  'funções de contexto fixam search_path vazio'
);
SELECT ok(
  has_function_privilege('antero_app', 'app.set_user_context(uuid)', 'EXECUTE')
  AND has_function_privilege('antero_app', 'app.current_user_id()', 'EXECUTE'),
  'antero_app executa set_user_context e current_user_id'
);
SELECT ok(
  NOT has_function_privilege('antero_auth', 'app.set_user_context(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('antero_auth', 'app.current_user_id()', 'EXECUTE')
  AND NOT has_schema_privilege('antero_auth', 'app', 'USAGE'),
  'antero_auth não usa o contexto da aplicação'
);
SELECT ok(
  NOT has_function_privilege('public', 'app.set_user_context(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'app.current_user_id()', 'EXECUTE'),
  'PUBLIC não executa as funções de contexto'
);

-- ---------------------------------------------------------------------------
-- Ausência de contexto
-- ---------------------------------------------------------------------------
SELECT is(app.current_user_id(), NULL, 'sem contexto: current_user_id() é NULL');
SELECT throws_ok(
  'SELECT app.set_user_context(NULL)',
  '22004',
  NULL,
  'set_user_context(NULL) é rejeitado'
);

-- ---------------------------------------------------------------------------
-- Escopo de transação
-- ---------------------------------------------------------------------------
BEGIN;
SELECT app.set_user_context(:'user_a');
SELECT is(app.current_user_id(), :'user_a'::uuid, 'dentro da transação: current_user_id() é o usuário definido');
COMMIT;
SELECT is(app.current_user_id(), NULL, 'após COMMIT: o contexto não vaza para a próxima transação');

BEGIN;
SELECT app.set_user_context(:'user_a');
ROLLBACK;
SELECT is(app.current_user_id(), NULL, 'após ROLLBACK: o contexto não vaza');

BEGIN;
SAVEPOINT antes_do_contexto;
SELECT app.set_user_context(:'user_a');
ROLLBACK TO SAVEPOINT antes_do_contexto;
SELECT is(app.current_user_id(), NULL, 'ROLLBACK TO SAVEPOINT desfaz o contexto');
COMMIT;

-- Conexão reaproveitada (pool): usuário A, depois usuário B, depois ninguém.
BEGIN;
SELECT app.set_user_context(:'user_a');
COMMIT;
BEGIN;
SELECT app.set_user_context(:'user_b');
SELECT is(app.current_user_id(), :'user_b'::uuid, 'pool: a transação seguinte vê só o próprio usuário (B)');
COMMIT;
BEGIN;
SELECT is(app.current_user_id(), NULL, 'pool: transação sem set_user_context não herda B');
COMMIT;

-- ---------------------------------------------------------------------------
-- Uso indevido: SET de sessão ou SET direto, sem set_user_context
-- ---------------------------------------------------------------------------
SELECT set_config('app.user_id', :'user_a', false) \g /dev/null
SELECT is(app.current_user_id(), NULL, 'SET de SESSÃO de app.user_id (sem marca da transação) é ignorado');

BEGIN;
SELECT set_config('app.user_id', :'user_a', true) \g /dev/null
SELECT is(app.current_user_id(), NULL, 'SET LOCAL direto de app.user_id (sem set_user_context) é ignorado');
COMMIT;

-- Cópia deliberada do contexto para o nível de SESSÃO: vale só na transação
-- que o criou; na próxima a marca não confere.
BEGIN;
SELECT app.set_user_context(:'user_a');
SELECT set_config('app.user_id', current_setting('app.user_id'), false),
       set_config('app.user_context_tx', current_setting('app.user_context_tx'), false) \g /dev/null
COMMIT;
SELECT is(current_setting('app.user_id'), :'user_a', 'pré-condição: app.user_id persistiu na sessão');
SELECT is(app.current_user_id(), NULL, 'contexto copiado para a sessão NÃO vale na transação seguinte');
BEGIN;
SELECT is(app.current_user_id(), NULL, 'nem em uma transação explícita posterior');
COMMIT;

RESET app.user_id;
RESET app.user_context_tx;

-- Valor que não é uuid: falha fechada (erro), nunca acesso.
BEGIN;
SELECT app.set_user_context(:'user_a');
SELECT set_config('app.user_id', 'nao-e-uuid', true) \g /dev/null
SELECT throws_ok('SELECT app.current_user_id()', '22P02', NULL, 'app.user_id adulterado para não-uuid gera erro (falha fechada)');
-- COMMIT (não ROLLBACK): o resultado do pgTAP fica numa tabela temporária e
-- seria desfeito junto. O contexto local é descartado do mesmo jeito.
COMMIT;

SELECT * FROM finish();
