# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Pessoas no Brasil que querem acompanhar contas, cartões, faturas e compromissos recorrentes em um único lugar, com uso frequente no celular e análise mais detalhada no computador.

## Product Purpose

O Securo consolida dados financeiros manuais e conectados para tornar saldos, despesas, faturas, recorrências e projeções compreensíveis e acionáveis.

## Positioning

Combina controle financeiro pessoal com transparência sobre a origem e a confiabilidade de cada valor, distinguindo dados informados por instituições de estimativas calculadas pelo próprio sistema.

## Operating Context

O usuário conecta instituições financeiras, revisa transações sincronizadas, acompanha faturas de cartão, cadastra compromissos recorrentes e consulta projeções mensais. O produto precisa continuar útil quando uma instituição atrasa ou entrega dados incompletos.

## Capabilities and Constraints

- Aplicação web responsiva em React, com backend próprio e integrações bancárias, inclusive Pluggy.
- Suporta contas, cartões, faturas, limites compartilhados, transações, categorias, recorrências, orçamentos e relatórios.
- Dados bancários podem chegar atrasados, duplicados ou incompletos; valores consolidados precisam indicar quando são estimados.
- A interface deve preservar os módulos e fluxos existentes do Securo.

## Brand Commitments

Manter o nome Securo, a linguagem direta em português e a identidade visual já presente na aplicação.

## Evidence on Hand

O repositório contém a implementação atual, modelos de cartões e faturas, integração bancária, testes e componentes visuais existentes. Não há capturas autenticadas do aplicativo de referência; suas telas públicas servem apenas como referência funcional.

## Product Principles

- Mostrar primeiro o que o usuário precisa decidir neste mês.
- Explicar a procedência e o grau de confiança dos números.
- Consolidar sem esconder a composição por conta ou cartão.
- Funcionar bem em telas pequenas antes de acrescentar densidade no desktop.
- Tratar ausência, atraso e divergência de dados como estados normais do produto.

## Accessibility & Inclusion

A interface deve preservar navegação por teclado, contraste adequado, rótulos claros e suporte a redução de movimento.
