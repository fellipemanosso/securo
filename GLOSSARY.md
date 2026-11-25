# Securo

Linguagem do domínio financeiro usada para organizar Contas, Cartões e suas obrigações.

## Cartões

**Ciclo de Faturamento**:
Intervalo de datas que agrupa as compras de um Cartão para uma cobrança.
_Avoid_: Fatura

**Fatura**:
Obrigação fechada emitida pela instituição financeira ou registrada manualmente, com valor e vencimento definidos.
_Avoid_: Projeção, Ciclo de Faturamento

**Projeção de Fatura**:
Estimativa do valor esperado para um Ciclo de Faturamento ainda não representado por uma Fatura.
_Avoid_: Fatura estimada

**Previsão de Cobrança**:
Fatura em que a instituição financeira informa que vai cobrar uma compra que ainda não faturou, como um Pix no crédito.
_Avoid_: Projeção de Fatura

**Parcela Prevista**:
Parcela de uma compra parcelada que a instituição financeira ainda não enviou, esperada numa Fatura futura.
_Avoid_: Projeção de Fatura, Previsão de Cobrança

**Cartão Oculto**:
Número de cartão de uma conta cujas compras o usuário retirou de todas as listas, totais e Faturas exibidas.
_Avoid_: Cartão excluído, Conta encerrada
