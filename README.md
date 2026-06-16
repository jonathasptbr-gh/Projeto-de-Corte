# Projeto de Corte (PWA)

App web instalável (PWA, funciona offline) para marcenaria/MDF que:

1. **Importa um CSV** no formato CutList (`C, L, Q, Material, NOME, …`) e abastece a lista de painéis automaticamente.
2. **Gera o plano de corte por aproveitamento** das chapas (otimização 2D guilhotinada com kerf, rotação e direção do grão), desenhando cada chapa em SVG.
3. **Calcula o orçamento** a partir dos dados do plano (nº de peças, metros de fita, cortes e chapas usadas) somados a itens manuais (pés, dobradiças, puxadores, etc.).

## Abas

| Aba | Função |
|-----|--------|
| **Painéis & Stock** | Importar CSV / editar peças, definir chapas (stock) e opções (kerf, rotação, grão, material, unidade). |
| **Plano de Corte** | Botão *Calcular plano* → métricas (chapas, peças, cortes, fita, aproveitamento) e desenho das chapas. |
| **Orçamento** | Tabela de materiais (quantidades cinzas vêm do plano), condições e gráfico de custo por material. |

## Fórmulas do orçamento

```
Entrada     = Σ subtotais dos materiais
Mão de obra = Entrada × (% mão de obra)        (padrão 80%)
Total       = (Entrada + Mão de obra) × (1 + margem%)   (padrão 10%)
Pix         = Total × (1 − desconto Pix%)      (padrão 10%)
Tempo       = nº de peças × dias por peça
```

Todos os percentuais e preços unitários são editáveis e salvos no navegador (localStorage).

## Formato do CSV

Colunas: `C` (comprimento), `L` (largura), `Q` (quantidade), `Material`, `NOME`,
`Enabled`, `Grain direction`, `Top band`, `Left band`, `Bottom band`, `Right band`, `Ordem`.
Linhas vazias e sem medidas são ignoradas. Aceita separador `,` ou `;` e decimal com `,` ou `.`.

## Rodar localmente

É estático — qualquer servidor HTTP serve (o Service Worker exige `http`, não `file://`):

```bash
python3 -m http.server 8080
# abra http://localhost:8080
```

Em produção (ex.: GitHub Pages) o app fica instalável como PWA.

## Estrutura

```
index.html          # shell + 3 abas
css/styles.css
js/csv.js           # leitor de CSV
js/optimizer.js     # bin-packing guilhotinado
js/render.js        # desenho SVG das chapas
js/budget.js        # cálculo do orçamento
js/app.js           # estado, UI, persistência
manifest.json, sw.js, icons/
```
