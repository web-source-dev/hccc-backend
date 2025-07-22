module.exports = function getRandomUSCustomerDetails() {
    const phones = [
      '+1 212-555-0180',
      '+1 312-555-0191',
      '+1 415-555-0173',
      '+1 646-555-0127',
      '+1 702-555-0168'
    ];
  
    const addresses = [
      {
        line1: '145 E 47th St',
        city: 'New York',
        state: 'NY',
        postal_code: '10017'
      },
      {
        line1: '233 S Wacker Dr',
        city: 'Chicago',
        state: 'IL',
        postal_code: '60606'
      },
      {
        line1: '1 Market St',
        city: 'San Francisco',
        state: 'CA',
        postal_code: '94105'
      },
      {
        line1: '3790 Las Vegas Blvd S',
        city: 'Las Vegas',
        state: 'NV',
        postal_code: '89109'
      },
      {
        line1: '700 W Capitol Ave',
        city: 'Little Rock',
        state: 'AR',
        postal_code: '72201'
      }
    ];
  
    const phone = phones[Math.floor(Math.random() * phones.length)];
    const address = addresses[Math.floor(Math.random() * addresses.length)];
  
    return { phone, address };
  }
  