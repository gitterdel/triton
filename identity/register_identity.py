"""Registro de Triton como agente ERC-8004 en BSC testnet.

El gas está patrocinado por MegaFuel paymaster en testnet, así que no
necesita tBNB. La clave de identidad la genera el SDK; la wallet de
trading (TWAK) se referencia en la descripción del agente.
"""

import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from bnbagent import ERC8004Agent, AgentEndpoint, EVMWalletProvider

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

TRADING_WALLET_BSC = "0x111Be0cD38B05B56253b4b7B5F3F39f6a64cEfc7"
STATE_FILE = Path(__file__).resolve().parent / "identity.json"


def main() -> None:
    password = os.getenv("TWAK_WALLET_PASSWORD")
    if not password:
        sys.exit("Falta TWAK_WALLET_PASSWORD en triton/.env")

    # Reutiliza la clave de identidad si ya existe un registro previo
    private_key = None
    if STATE_FILE.exists():
        saved = json.loads(STATE_FILE.read_text())
        private_key = saved.get("identityPrivateKey")
        print(f"Reutilizando clave de identidad existente ({saved.get('identityAddress')})")

    wallet = EVMWalletProvider(password=password, private_key=private_key)
    sdk = ERC8004Agent(network="bsc-testnet", wallet_provider=wallet)

    agent_uri = sdk.generate_agent_uri(
        name="Triton",
        description=(
            "Autonomous trading agent for BNB HACK 2026. Reads CoinMarketCap "
            "signals (momentum + Fear & Greed regime), applies hard risk limits "
            "(stop-loss, daily loss cap, kill switch) and executes swaps on BSC "
            f"via Trust Wallet Agent Kit. Trading wallet: {TRADING_WALLET_BSC}. "
            "TWAK Agent ID: 247ddb0f-8635-46ff-99de-089ba64afe84."
        ),
        endpoints=[
            AgentEndpoint(
                name="dashboard",
                endpoint="http://localhost:7777",  # TODO: URL pública al desplegar
                version="0.1.0",
            ),
        ],
    )

    result = sdk.register_agent(agent_uri=agent_uri)
    print(f"Agente registrado. ID: {result['agentId']}, TX: {result['transactionHash']}")

    STATE_FILE.write_text(
        json.dumps(
            {
                "agentId": result["agentId"],
                "transactionHash": result["transactionHash"],
                "network": "bsc-testnet",
                "identityAddress": getattr(wallet, "address", None) or result.get("address"),
                "identityPrivateKey": getattr(wallet, "private_key", None) or private_key,
                "tradingWallet": TRADING_WALLET_BSC,
            },
            indent=2,
        )
    )
    print(f"Estado guardado en {STATE_FILE}")


if __name__ == "__main__":
    main()
