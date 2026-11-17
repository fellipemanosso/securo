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
