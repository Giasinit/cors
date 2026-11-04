#!/usr/bin/env python3
"""Compile this NeTEx profile into date bitsets and train operating windows."""
import argparse
import base64
import collections
import datetime as dt
import gzip
import hashlib
import json
import pathlib
import re
import xml.etree.ElementTree as ET

NS = '{http://www.netex.org.uk/netex}'
WEEKDAYS = dict(zip(('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'), range(7)))


def text(element, name, default=None):
    return element.findtext(NS + name, default=default)


def date(value):
    return dt.date.fromisoformat(value[:10])


def seconds(value, offset='0'):
    h, m, s = map(int, value.split(':'))
    if h < 0 or not 0 <= m < 60 or not 0 <= s < 60 or int(offset) < 0:
        raise ValueError('Invalid timetable time')
    return int(offset) * 86400 + h * 3600 + m * 60 + s


def compile_calendar(source):
    source = pathlib.Path(source)
    weekdays, periods, assignments, journeys = {}, {}, [], []
    counts = collections.Counter()
    publication, timezone = None, None
    wanted = {'DayType', 'UicOperatingPeriod', 'OperatingPeriod', 'DayTypeAssignment', 'ServiceJourney'}
    stack, captured = [], None
    for event, element in ET.iterparse(source, events=('start', 'end')):
        tag = element.tag.removeprefix(NS)
        if event == 'start':
            stack.append(element)
            if captured is None and tag in wanted:
                captured = element
            continue
        if captured is element:
            counts[tag] += 1
            if tag == 'DayType':
                names = ' '.join(x.text or '' for x in element.findall('.//' + NS + 'DaysOfWeek')).split()
                if any(x.text and x.text.strip() for x in element.findall('.//' + NS + 'HolidayTypes')):
                    raise ValueError('HolidayTypes needs explicit normalization')
                weekdays[element.attrib['id']] = {WEEKDAYS[n] for n in names} if names else set(range(7))
            elif tag in {'OperatingPeriod', 'UicOperatingPeriod'}:
                start, end = date(text(element, 'FromDate')), date(text(element, 'ToDate'))
                bits = text(element, 'ValidDayBits')
                if bits is None and tag == 'OperatingPeriod':
                    bits = '1' * ((end - start).days + 1)
                bits = ''.join((bits or '').split())
                if len(bits) != (end - start).days + 1 or set(bits) - {'0', '1'}:
                    raise ValueError('Invalid ValidDayBits: ' + element.attrib['id'])
                periods[element.attrib['id']] = (start, end, bits)
            elif tag == 'DayTypeAssignment':
                day = element.find(NS + 'DayTypeRef')
                period = element.find(NS + 'OperatingPeriodRef')
                explicit = text(element, 'Date')
                available = text(element, 'IsAvailable', 'true').strip()
                if day is None or (period is None and explicit is None) or available not in {'true', 'false'}:
                    raise ValueError('Unsupported DayTypeAssignment: ' + element.attrib['id'])
                assignments.append((day.attrib['ref'], period.attrib['ref'] if period is not None else None,
                                    date(explicit) if explicit else None, available == 'true'))
            elif tag == 'ServiceJourney':
                if text(element, 'TransportMode') != 'rail':
                    counts['excluded_non_rail'] += 1
                else:
                    number = (text(element, 'Name', '') or '').strip()
                    if not re.fullmatch(r'[0-9]+', number):
                        raise ValueError('Non-numeric rail journey name: ' + number)
                    refs = [x.attrib['ref'] for x in element.findall(NS + 'dayTypes/' + NS + 'DayTypeRef')]
                    if not refs:
                        raise ValueError('Journey without DayTypeRef')
                    start = seconds(text(element, 'DepartureTime'), text(element, 'DepartureDayOffset', '0'))
                    times = []
                    for passing in element.findall(NS + 'passingTimes/' + NS + 'TimetabledPassingTime'):
                        for name in ('Arrival', 'Departure'):
                            value = text(passing, name + 'Time')
                            if value:
                                times.append(seconds(value, text(passing, name + 'DayOffset', '0')))
                    if not times or times != sorted(times) or times[-1] < start:
                        raise ValueError('Non-monotone or missing journey times: ' + number)
                    journeys.append((number, start, times[-1], tuple(refs)))
            captured = None
        elif captured is not None:
            stack.pop()
            continue
        elif tag == 'PublicationTimestamp':
            publication = element.text
        elif tag == 'TimeZone' and timezone is None:
            timezone = element.text
        if len(stack) > 1:
            stack[-2].remove(element)
        element.clear()
        stack.pop()
    if not periods or not journeys or timezone != 'Europe/Rome':
        raise ValueError('Missing calendars, journeys or supported timezone')
    all_dates = [x[0] for x in periods.values()] + [x[1] for x in periods.values()]
    all_dates += [a[2] for a in assignments if a[2] is not None]
    first, last = min(all_dates), max(all_dates)
    days = (last - first).days + 1
    includes, excludes, exceptions = {}, {}, {}
    for day_ref, period_ref, explicit, available in assignments:
        if day_ref not in weekdays:
            raise ValueError('Unknown DayTypeRef: ' + day_ref)
        if explicit is not None:
            key = (day_ref, explicit)
            if key in exceptions and exceptions[key] != available:
                raise ValueError('Conflicting date exceptions')
            exceptions[key] = available
            continue
        if period_ref not in periods:
            raise ValueError('Unknown OperatingPeriodRef: ' + period_ref)
        start, end, bits = periods[period_ref]
        mask = 0
        for i, value in enumerate(bits):
            current = start + dt.timedelta(days=i)
            if value == '1' and current.weekday() in weekdays[day_ref]:
                mask |= 1 << (current - first).days
        target = includes if available else excludes
        target[day_ref] = target.get(day_ref, 0) | mask
    masks = {ref: includes.get(ref, 0) & ~excludes.get(ref, 0) for ref in weekdays}
    for (ref, day), available in exceptions.items():
        bit = 1 << (day - first).days
        masks[ref] = (masks[ref] | bit) if available else (masks[ref] & ~bit)
    grouped = {}
    for number, start, end, refs in journeys:
        mask = 0
        for ref in refs:
            if ref not in masks:
                raise ValueError('Unresolved journey calendar: ' + ref)
            mask |= masks[ref]
        key = (number, start, end)
        grouped[key] = grouped.get(key, 0) | mask
    packed = sorted({mask for mask in grouped.values() if mask})
    index = {mask: i for i, mask in enumerate(packed)}
    rows = [[*key, index[mask]] for key, mask in sorted(grouped.items()) if mask]
    counts['rail_journeys'] = len(journeys)
    counts['compiled_windows'] = len(rows)
    counts['unique_calendars'] = len(packed)
    counts['train_numbers'] = len({r[0] for r in rows})
    digest = hashlib.sha256()
    with source.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return {'version': 1, 'timezone': timezone, 'from': first.isoformat(), 'to': last.isoformat(),
            'publication': publication, 'source': {'name': source.name, 'sha256': digest.hexdigest(), 'bytes': source.stat().st_size},
            'counts': dict(counts), 'maxEnd': max(r[2] for r in rows),
            'calendars': [base64.b64encode(mask.to_bytes((days + 7) // 8, 'little')).decode() for mask in packed],
            'trains': rows}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('--output', default='data/train-calendar.json.gz')
    args = parser.parse_args()
    data = compile_calendar(args.source)
    encoded = json.dumps(data, separators=(',', ':'), ensure_ascii=False).encode()
    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(gzip.compress(encoded, mtime=0))
    root = pathlib.Path(__file__).resolve().parents[1]
    if output.resolve() == root / 'data/train-calendar.json.gz':
        go_copy = root / 'benchmark/assets/train-calendar.json.gz'
        go_copy.parent.mkdir(parents=True, exist_ok=True)
        go_copy.write_bytes(output.read_bytes())
    print(json.dumps({**{k: v for k, v in data.items() if k not in {'calendars', 'trains'}},
                      'jsonBytes': len(encoded), 'gzipBytes': output.stat().st_size}, indent=2))


if __name__ == '__main__':
    main()
