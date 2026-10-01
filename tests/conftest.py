import pytest

from sanctimaps_agent.adapter.site_data import SiteData, fold


class FakeSite(SiteData):
    """Géographie minimale, au format de data/generated/world.json du site."""

    def __init__(self):
        super().__init__(page=None)
        self.world = {
            "continents": [
                {"id": "europe", "bbox": [427778, 206720, 627778, 402800], "countries": ["FRA", "ITA", "ESP", "GBR"]},
            ],
            "countries": [
                {"id": "FRA", "name": "France", "continent": "europe", "bbox": [490000, 330000, 525000, 375000],
                 "focus": [490000, 330000, 525000, 375000], "label": [507000, 352000], "area": 1},
                {"id": "ITA", "name": "Italy", "continent": "europe", "bbox": [517000, 345000, 550000, 390000],
                 "focus": [517000, 345000, 550000, 390000], "label": [530000, 365000], "area": 1},
                {"id": "ESP", "name": "Spain", "continent": "europe", "bbox": [480000, 355000, 510000, 385000],
                 "focus": [480000, 355000, 510000, 385000], "label": [495000, 370000], "area": 1},
                {"id": "GBR", "name": "United Kingdom", "continent": "europe", "bbox": [480000, 300000, 505000, 335000],
                 "focus": [480000, 300000, 505000, 335000], "label": [492000, 320000], "area": 1},
            ],
        }
        self.names = {"FRA": {"fr": "France", "en": "France"}, "ITA": {"fr": "Italie", "en": "Italy"},
                      "ESP": {"fr": "Espagne", "en": "Spain"}, "GBR": {"fr": "Royaume-Uni", "en": "United Kingdom"}}
        self.country_by_id = {c["id"]: c for c in self.world["countries"]}
        self.continent_by_id = {c["id"]: c for c in self.world["continents"]}
        index = []
        for iso, c in self.country_by_id.items():
            for label in {c["name"], *self.names[iso].values()}:
                index.append((fold(label), iso))
        self._country_index = sorted(index, key=lambda i: -len(i[0]))
        self._cities = {"FRA": [{"n": "Paris", "x": 506524, "y": 344042, "p": 2138551},
                                {"n": "Lyon", "x": 513463, "y": 356765, "p": 472317}],
                        "ITA": [{"n": "Rome", "x": 534000, "y": 372000, "p": 2800000}]}


class FakeCorpus:
    def __init__(self):
        self.data = {"paris": ("FRA", [{"city": "Paris", "x": 506524, "y": 344042}]),
                     "lourdes": ("FRA", [{"city": "Lourdes", "x": 500000, "y": 368000}]),
                     "rome": ("ITA", [{"city": "Rome", "x": 534000, "y": 372000}])}

    async def city_country(self, name):
        return self.data.get(fold(name))


@pytest.fixture
def site():
    return FakeSite()


@pytest.fixture
def corpus():
    return FakeCorpus()
