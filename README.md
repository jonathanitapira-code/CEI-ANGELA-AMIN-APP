# App CEI Ângela Amin

Aplicativo web para a creche se comunicar com as famílias: chat por turma, cardápio diário e prestação de contas financeira.

## Funcionalidades

- **Login por número de telefone** (em vez de e-mail) + senha, com 9 papéis: Responsável (pai/mãe), Estagiária, Professora Regente, Professora Auxiliar, Cozinha, Diretora, Coordenadora Pedagógica, Secretária e Gestor. Contas de equipe (todas menos Responsável) exigem um "código da equipe" para evitar cadastros indevidos.

  ⚠️ Não é login por SMS/código de verificação — é telefone como identificador + senha, igual ao e-mail funcionava antes. Se no futuro você quiser verificação por SMS de verdade, é preciso contratar um serviço externo (ex: Twilio) e eu configuro a integração.
- **Foto de perfil**: cada pessoa pode colocar sua foto clicando no próprio nome/avatar no topo do app. Aparece no chat, nas conversas privadas e na lista "Quem é quem". Sem foto, aparece um círculo colorido com a inicial do nome.
- **Turmas criadas somente pelo Gestor** — as demais pessoas não veem mais a opção de criar turma. O Gestor gera o link de convite (`/?invite=CODIGO`) para os responsáveis entrarem.
- **Gerenciar quem está na turma**: o Gestor, a Coordenadora Pedagógica, ou a Professora Regente daquela turma específica podem adicionar uma pessoa já cadastrada diretamente (sem precisar do link) ou remover alguém, pela tela "Quem é quem".
- **Um responsável pode estar em mais de uma turma** (ex: irmãos em turmas diferentes) — isso já funcionava, sem precisar de nenhuma mudança.
- **Gestor tem acesso total**: enxerga e pode entrar em qualquer turma da creche mesmo sem ter sido adicionado nela, e passa em qualquer checagem de permissão do sistema — é o único cargo com esse acesso irrestrito.
- **Identificação de quem é quem**: dentro de cada turma há uma lista "Quem é quem" mostrando cada participante, seu papel (badge colorido) e, no caso dos responsáveis, o nome da criança.
- **Chat em tempo real por turma** (Socket.IO): mensagens de texto, com nome, papel e horário de quem enviou.
- **Fotos e PDFs no chat, sem download fácil**: os arquivos são servidos apenas para membros da turma, sempre "inline" (nunca como anexo/download). Imagens abrem em um visualizador dentro do app; PDFs são renderizados página a página em `<canvas>` via PDF.js, sem usar o leitor nativo do navegador (que teria botão de salvar). O menu de clique-direito é bloqueado nas imagens/PDFs.

  ⚠️ **Importante**: isso reduz bastante a facilidade de salvar os arquivos, mas nenhum app web consegue impedir 100% um print/captura de tela. Trate como uma barreira razoável, não como criptografia militar.
- **Mensagens privadas**: responsáveis podem abrir uma conversa 1:1 com as professoras/estagiária da turma do filho e com qualquer pessoa da direção. **Nunca é permitida conversa privada entre dois responsáveis.** A equipe também pode conversar livremente entre si. Suporta foto/PDF igual ao chat da turma (visualização dentro do app, sem download).
- **Apagar mensagens na turma**: qualquer pessoa pode apagar a própria mensagem; a professora regente e qualquer pessoa da direção também podem apagar mensagens enviadas por outras pessoas no chat da turma (fica registrado "Mensagem removida por Fulana"). Nas conversas privadas, só quem enviou pode apagar a própria mensagem.
- **Cardápio diário**: cozinha, professoras (regente/auxiliar/estagiária) ou direção registram o que foi oferecido em cada refeição (Café da Manhã, Almoço, Café da Tarde, Lanche Final) por data. Todos podem consultar por dia.
- **Financeiro simples com relatório mensal**: lançamentos de receitas e despesas com saldo calculado automaticamente. Tem um filtro por mês (ex: julho/2026) que mostra os totais só daquele período. Diretora, Gestor e Secretária lançam; qualquer pessoa logada pode visualizar (transparência com as famílias); só Diretora e Gestor podem excluir lançamentos.
- **Logo da creche** no topo do app e na tela de login — usando a arte original que você enviou (recortada e otimizada para web).
- **Instalar como aplicativo no celular (PWA)**: o app pode ser adicionado à tela inicial do Android/iPhone e abrir em tela cheia, como um app "de verdade" — sem precisar de loja de aplicativos. Veja a seção "📲 Instalar como aplicativo no celular" abaixo.
- **Esqueceu a senha? Redefinir senha**: como o login é por telefone (sem e-mail/SMS cadastrado), não existe um link automático de "recuperar senha" por enquanto. Na tela de login há um botão "Esqueceu sua senha?" explicando isso. A redefinição é feita por alguém da Direção (Diretora, Coordenadora Pedagógica, Secretária) ou pelo Gestor, direto no app, na nova aba **"Usuários"**: buscar a pessoa pelo nome/telefone, clicar em "Redefinir senha", definir uma senha temporária e avisar essa pessoa diretamente (telefone, WhatsApp, pessoalmente).

## 📲 Instalar como aplicativo no celular

**Android (Chrome):** ao abrir o site, aparece um botão **"📲 Instalar app no celular"** na tela de login (ou **"📲 Instalar"** no topo, depois de logado). É só tocar nele e confirmar. O ícone aparece na tela inicial do celular igual a qualquer outro app.

**iPhone/iPad (Safari):** o iOS não permite esse botão automático — aparece uma faixa azul explicando o passo manual: toque no ícone de **Compartilhar** (o quadrado com a seta pra cima, na barra do Safari) e depois em **"Adicionar à Tela de Início"**.

Depois de instalado, o app abre sem a barra de endereço do navegador, com o ícone e nome "CEI Ângela Amin". Por baixo dos panos ele continua sendo o mesmo site — os dados (mensagens, financeiro, etc.) sempre vêm direto do servidor, nada fica "preso" desatualizado no celular. Só os arquivos que não mudam (visual do app) ficam guardados para abrir mais rápido e funcionar minimamente offline.

⚠️ Sempre que eu enviar uma atualização de código depois desta, o celular das pessoas vai puxar a versão nova sozinho na próxima vez que abrirem o app com internet — não precisa desinstalar/reinstalar.

## ⚠️ Sobre esta atualização especificamente

O jeito de fazer login mudou de e-mail para telefone, e algumas colunas novas foram adicionadas (foto de perfil, etc). Por isso o banco de dados passou a usar um arquivo novo (`creche_v2.db` em vez de `creche.db`). **Mesmo com o disco persistente configurado, essa atualização específica vai fazer todo mundo precisar se cadastrar de novo uma última vez** — depois disso, com o disco persistente, os dados ficam salvos normalmente nas próximas atualizações (contanto que eu não mude a estrutura das tabelas de novo).

## Como rodar localmente

Pré-requisitos: [Node.js](https://nodejs.org) versão 18 ou mais recente.

```bash
npm install
npm start
```

Acesse **http://localhost:3000**.

Na primeira vez, crie sua conta como **"Gestor"** (é quem cria as turmas agora) usando o código da equipe padrão:

```
creche2026
```

**Troque esse código antes de usar de verdade**, definindo a variável de ambiente `STAFF_CODE` (veja abaixo).

## Variáveis de ambiente (opcionais)

| Variável         | Para quê serve                                   | Padrão                          |
|------------------|---------------------------------------------------|----------------------------------|
| `PORT`           | Porta do servidor                                  | `3000`                           |
| `SESSION_SECRET` | Chave usada para assinar o cookie de sessão        | valor de exemplo — **troque!**   |
| `STAFF_CODE`     | Código que toda a equipe (não-responsáveis) usa para se cadastrar | `creche2026` — **troque!** |

Exemplo:
```bash
PORT=3000 SESSION_SECRET="uma-chave-bem-aleatoria" STAFF_CODE="minha-creche-2026" npm start
```

## Como disponibilizar para as famílias (fora do seu computador)

Hoje o app roda como um servidor único (Node + SQLite). Para pais e professores acessarem de casa/celular, ele precisa estar hospedado em algum lugar acessível pela internet. Algumas opções simples e de baixo custo:

1. **Render.com / Railway.app** — conecte este código a um repositório Git, escolha "Web Service" Node, defina as variáveis de ambiente acima, e pronto: você recebe uma URL pública (ex.: `https://cei-angela-amin.onrender.com`).
2. **Um VPS simples** (ex.: uma máquina pequena na DigitalOcean/Hetzner) rodando `npm start` com um gerenciador de processos como `pm2`, atrás de um proxy HTTPS (Nginx + Let's Encrypt).
3. Para testes internos na mesma rede Wi-Fi da creche, dá pra rodar localmente e acessar pelo IP da máquina (ex. `http://192.168.0.10:3000`) — mas isso não funciona fora da rede.

O `server.js` já vem configurado para funcionar certo atrás de HTTPS (Render, por exemplo) sem precisar editar nada.

## Deixando os dados salvos de verdade (plano pago + disco persistente)

No plano gratuito do Render, o banco de dados e as fotos do chat somem a cada novo deploy ou reinício. Para isso não acontecer mais, o caminho mais barato é:

1. No Render, vá no seu serviço → **Settings** → **Instance Type** → mude de **Free** para **Starter** (US$7/mês). Vai pedir para cadastrar um cartão em **Billing**, se ainda não tiver.
2. Ainda no serviço, vá em **Disk** (no menu lateral) → **Add Disk**.
   - Name: `creche-data`
   - Mount Path: `/var/data`
   - Size: 1 GB já é suficiente para começar (US$0,25/mês; dá para aumentar depois se precisar de mais espaço para fotos).
3. Em **Environment**, adicione a variável `DISK_MOUNT_PATH` com o valor `/var/data` (tem que ser exatamente igual ao Mount Path do passo 2).
4. Suba o `server.js` atualizado (a versão mais recente já sabe usar essa variável para guardar os dados dentro do disco).
5. Espere o deploy terminar. A partir daí, cadastros, turmas, conversas, cardápio e financeiro **não são mais apagados** em deploys/reinícios futuros.

Custo total desse caminho: **US$7/mês (Starter) + US$0,25/mês (1 GB de disco) ≈ US$7,25/mês**, cobrado proporcional ao tempo de uso pelo Render.

## Estrutura dos arquivos

Como o projeto foi criado dentro de uma pasta de saída sem subpastas, todos os arquivos ficam juntos na raiz:

- `server.js` — todo o backend (Express + Socket.IO + SQLite + rotas).
- `index.html`, `style.css`, `app.js` — o front-end (uma única página).
- `logo.png` — logotipo completo (ícone + nome), usado na tela de login.
- `logo-icon.png` — só o ícone circular, usado no topo do app e como ícone do site.
- `icon-192.png`, `icon-512.png`, `icon-apple-180.png` — ícones em tamanhos exigidos para instalar o app como PWA (Android/iOS).
- `manifest.json` — arquivo de configuração do PWA (nome, cor, ícones).
- `sw.js` — service worker: permite instalar o app e guarda em cache os arquivos que não mudam (nunca guarda mensagens, financeiro ou anexos, sempre buscados do servidor).
- `package.json` — dependências do projeto.
- `data/` e `uploads/` — criadas automaticamente ao rodar (banco SQLite e arquivos enviados no chat). **Não vá para o Git** — já é comum ignorá-las (veja abaixo).

Se quiser organizar em pastas (`server/`, `public/`) no seu computador, sinta-se à vontade — o código não depende de nomes de pasta específicos, só do `require`/caminhos usados hoje.

Sugestão de `.gitignore` caso publique num repositório:
```
node_modules/
data/
uploads/
```

## Sobre o logo

`logo.png` e `logo-icon.png` foram recortados diretamente do arquivo original que você enviou (`03 logotipo_vertical_com_fundo.png`), então é exatamente a sua arte — só redimensionada/otimizada para carregar rápido no navegador.

## Papéis e permissões (resumo)

| Ação | Responsável | Estagiária | Prof. Regente | Prof. Auxiliar | Cozinha | Diretora | Coord. Pedagógica | Secretária | Gestor |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Entrar em turma pelo link       | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Criar turma / gerar convite     | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Adicionar/remover pessoa de uma turma (sem link) | ❌ | ❌ | ✅ (só nas turmas em que ela está) | ❌ | ❌ | ❌ | ✅ (qualquer turma) | ❌ | ✅ (qualquer turma) |
| Ver/entrar em qualquer turma mesmo sem ser membro | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Enviar mensagens/fotos/PDF no chat | ✅ | ✅ (se estiver na turma) | ✅ | ✅ | ✅ (se estiver na turma) | ✅ | ✅ | ✅ (se estiver na turma) | ✅ |
| Publicar cardápio               | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Ver cardápio                    | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Remover item do cardápio de outra pessoa | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ |
| Lançar receita/despesa          | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| Ver financeiro (incl. relatório mensal) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Excluir lançamento financeiro   | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Redefinir senha de outra pessoa | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |

Quem sempre pode enviar mensagens no chat: qualquer pessoa que seja membro daquela turma (entrou pelo link de convite ou foi adicionada por quem gerencia a turma).

**Sobre o Gestor**: além das permissões marcadas acima, o Gestor passa automaticamente em qualquer checagem de permissão do sistema (é o "acesso total" que você pediu) — então mesmo que eu esqueça de marcar um ✅ nessa tabela, o Gestor consegue fazer aquilo mesmo assim. Os outros cargos continuam exatamente com o que está marcado.

### Regra das mensagens privadas

- Responsável ↔ Direção (Diretora, Coordenadora Pedagógica, Secretária, Gestor): sempre pode, mesmo sem estarem na mesma turma.
- Responsável ↔ Professora Regente / Professora Auxiliar / Estagiária: só se essa pessoa da equipe estiver na(s) mesma(s) turma(s) que o responsável (ou seja, é professora do filho dela).
- Responsável ↔ Responsável: **nunca permitido.**
- Equipe ↔ Equipe (qualquer combinação de cargos da equipe): sempre pode.

### Apagar mensagens

- Chat da turma: dono da mensagem, professora regente ou qualquer pessoa da direção.
- Conversa privada: só quem enviou a mensagem.
- A mensagem não some do banco de dados — ela fica marcada como removida e aparece como "Mensagem removida" para preservar o histórico da conversa.

Achou alguma dessas regras diferente do que sua creche precisa? É só pedir — dá pra ajustar cada linha dessa tabela facilmente no código (`server.js`, no topo, tem as listas `TURMA_CREATE_ROLES`, `CARDAPIO_ROLES`, `FIN_MANAGE_ROLES` etc.).

## Limitações conhecidas (é um app funcional, mas ainda um primeiro passo)

- Sessões ficam em memória: reiniciar o servidor derruba todo mundo logado. Para produção com mais uso, trocar por um "session store" persistente (ex. `connect-sqlite3`) é recomendado.
- Não há recuperação de senha por e-mail (seria o próximo passo natural).
- Não há envio de notificação push quando chega mensagem nova — é preciso abrir o app.
- Bloqueio de download de fotos/PDFs é "best effort" (explicado acima).
