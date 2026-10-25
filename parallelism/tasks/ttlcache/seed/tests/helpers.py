class FakeClock:
    def __init__(self, start=100.0):
        self.now = start
        self.calls = 0

    def __call__(self):
        self.calls += 1
        return self.now

    def advance(self, dt):
        self.now += dt
