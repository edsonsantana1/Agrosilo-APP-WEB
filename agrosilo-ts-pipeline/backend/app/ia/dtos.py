"""
DTOs (Data Transfer Objects) usados pela API de IA.

Mantemos as classes em um módulo separado para:
- organizar melhor o código,
- facilitar futura reutilização em outros módulos (ex.: testes, outros routers),
- seguir o princípio de responsabilidade única (SRP).
"""

from typing import Any, Dict
from pydantic import BaseModel, Field


class IAQueryRequest(BaseModel):
    """
    Representa a requisição enviada pelo front-end para a assistente.

    O front apenas envia o TEXTO da frase (já reconhecida via microfone).
    Exemplo: "Olá Iara, qual a temperatura e umidade do silo 1?"
    """
    text: str = Field(
        ...,
        description="Frase de comando já transcrita.",
        min_length=3,
    )


class IAQueryResponse(BaseModel):
    """
    Representa a resposta da assistente.

    - `reply` é o texto em linguagem natural pronto para ser exibido
      ou sintetizado em áudio.
    - `data` contém detalhes estruturados (valores, status, alertas),
      permitindo que o front construa cards, tabelas ou gráficos.
    """
    reply: str = Field(..., description="Texto da resposta da assistente.")
    data: Dict[str, Any] = Field(
        default_factory=dict,
        description="Dados estruturados opcionais (valores, status, alertas).",
    )
