from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_path: str = "./data/proxies.db"
    target_pool_size: int = 50
    fetch_interval_seconds: int = 300
    check_interval_seconds: int = 30
    check_concurrency: int = 300
    check_timeout_seconds: float = 2.0
    min_success_rate: float = 1.0
    min_checks: int = 2
    stale_after_seconds: int = 180
    check_targets: str = "https://www.google.com/generate_204"
    max_candidates_per_cycle: int = 0
    api_key: str = ""
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
