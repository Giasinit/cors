import base64
import importlib.util
import pathlib
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('compiler', pathlib.Path(__file__).parents[1] / 'scripts/compile_calendar.py')
compiler = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compiler)


def fixture(extra='', refs='D', start='23:30:00', end='01:00:00', offset='1'):
    return f'''<PublicationDelivery xmlns="http://www.netex.org.uk/netex">
    <PublicationTimestamp>2026-10-29T00:00:00Z</PublicationTimestamp><TimeZone>Europe/Rome</TimeZone>
    <DayType id="D"><properties><PropertyOfDay><DaysOfWeek>Monday Tuesday Wednesday Thursday Friday Saturday Sunday</DaysOfWeek></PropertyOfDay></properties></DayType>
    <UicOperatingPeriod id="P"><FromDate>2026-11-03</FromDate><ToDate>2026-11-05</ToDate><ValidDayBits>111</ValidDayBits></UicOperatingPeriod>
    <DayTypeAssignment id="A"><OperatingPeriodRef ref="P"/><DayTypeRef ref="D"/></DayTypeAssignment>
    {extra}<ServiceJourney id="J"><Name>757</Name><TransportMode>rail</TransportMode>
    <DepartureTime>{start}</DepartureTime><dayTypes><DayTypeRef ref="{refs}"/></dayTypes>
    <passingTimes><TimetabledPassingTime><DepartureTime>{start}</DepartureTime></TimetabledPassingTime>
    <TimetabledPassingTime><ArrivalTime>{end}</ArrivalTime><ArrivalDayOffset>{offset}</ArrivalDayOffset></TimetabledPassingTime></passingTimes>
    </ServiceJourney></PublicationDelivery>'''


class CalendarCompilerTest(unittest.TestCase):
    def compile(self, value):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / 'test.xml'
            source.write_text(value)
            return compiler.compile_calendar(source)

    def test_exact_bit_dates_and_night_offsets(self):
        d = self.compile(fixture())
        self.assertEqual(d['trains'][0][:3], ['757', 84600, 90000])
        self.assertEqual(base64.b64decode(d['calendars'][0])[0], 7)

    def test_explicit_date_exclusion(self):
        d = self.compile(fixture('<DayTypeAssignment id="E"><Date>2026-11-04</Date><DayTypeRef ref="D"/><IsAvailable>false</IsAvailable></DayTypeAssignment>'))
        self.assertEqual(base64.b64decode(d['calendars'][0])[0], 5)

    def test_weekday_mask_intersects_uic_period(self):
        xml = fixture().replace('Monday Tuesday Wednesday Thursday Friday Saturday Sunday', 'Wednesday')
        d = self.compile(xml)
        self.assertEqual(base64.b64decode(d['calendars'][0])[0], 2)

    def test_missing_ref_and_non_monotone_times_fail(self):
        with self.assertRaises(ValueError): self.compile(fixture(refs='UNKNOWN'))
        with self.assertRaises(ValueError): self.compile(fixture(offset='0'))


if __name__ == '__main__': unittest.main()
