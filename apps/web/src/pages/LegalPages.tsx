/** Versões resumidas para o app; o texto jurídico completo fica em docs/06-seguranca-e-lgpd.md. */
export function PrivacyPage() {
  return (
    <main className="page prose">
      <h1>Política de Privacidade (resumo)</h1>
      <p><strong>Quais dados coletamos:</strong> nome, e-mail, senha (guardada apenas como hash Argon2id), foto de perfil opcional,
        município opcional e as rotas que você decide salvar. Não guardamos o histórico das suas buscas nem a sua localização.</p>
      <p><strong>Para quê:</strong> autenticar você, salvar e compartilhar suas rotas e produzir estatísticas agregadas e
        anônimas de demanda por município para melhorar o transporte público.</p>
      <p><strong>Foto de perfil:</strong> é redimensionada e tem os metadados (incluindo localização GPS) removidos antes de ser armazenada.</p>
      <p><strong>Compartilhamento:</strong> quem recebe o link vê apenas o nome da rota, os pontos e o seu primeiro nome. Você pode desativar o link a qualquer momento.</p>
      <p><strong>Seus direitos (LGPD, art. 18):</strong> no seu perfil você baixa todos os seus dados e exclui a conta, sem precisar pedir a ninguém.</p>
      <p><strong>Encarregado (DPO):</strong> contato publicado pelo órgão responsável pela operação do serviço.</p>
    </main>
  );
}

export function TermsPage() {
  return (
    <main className="page prose">
      <h1>Termos de Uso (resumo)</h1>
      <p>O Mobi GO é gratuito. Os horários e previsões vêm das operadoras e do GPS dos ônibus e podem ter atrasos ou falhas;
        use-os como estimativa. Não use o app enquanto dirige. É proibido usar o serviço para coletar dados de outras pessoas
        ou sobrecarregar a infraestrutura.</p>
    </main>
  );
}
